// المشتريات: طلبية BC ← موافقة المدير ← عربون ← تأكيد بلوتات ومستحق
// القواعد: لا أثر مخزني/مالي قبل التأكيد + المؤخر لا يخصم + الجزئي يبقى مفتوحاً
const jstore = require('./jstore');
const System = require('./system');
const Auth = require('./auth');
const mstore = require('./store');
const Master = require('./master');
const Stock = require('./stock');
const Finance = require('./finance');

const db = jstore('procurement.json', {
  seq: { order: 1, order_num: 1, deposit: 1, confirmation: 1, audit: 1 },
  orders: [], deposits: [], confirmations: [], audit: []
});
const now = () => new Date().toISOString();
const r2 = n => Math.round(Number(n || 0) * 100) / 100;

const METHODS = ['نقدي', 'تحويل بنكي', 'شيك', 'مؤخر'];
const CASH_METHODS = ['نقدي', 'تحويل بنكي', 'شيك']; // المؤخر وعد لا يخصم

function err(msg, code) { throw Object.assign(new Error(msg), { code: code || 400 }); }
function toNum(v, field) {
  if (v === null || v === undefined || v === '') return 0;
  let s = String(v).trim();
  if (s === '') return 0;
  s = s.replace(/[٠-٩]/g, ch => '٠١٢٣٤٥٦٧٨٩'.indexOf(ch))
       .replace(/[۰-۹]/g, ch => '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch))
       .replace(/[\s  ']/g, '').replace(/٬/g, '').replace(/[٫,]/g, '.');
  const parts = s.split('.');
  if (parts.length > 2) s = parts.shift() + '.' + parts.join('');
  const n = Number(s);
  if (!Number.isFinite(n)) err((field || 'الرقم') + ': رقم غير صالح');
  return n;
}
function validDate(v, field) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) err((field || 'التاريخ') + ': صيغة غير صحيحة (سنة-شهر-يوم)');
  return s;
}
// ترميم ذاتي لعدادات التسلسل: أي مفتاح ناقص/تالف يُعاد بناؤه من أعلى معرف موجود
// (يحمي من ملفات قديمة أو مصفّرة يدوياً — يمنع خطأ «رقم تسلسلي غير صالح» نهائياً)
function fixSeq(d) {
  d.seq = d.seq || {};
  const mx = a => Math.max(0, ...((d[a] || []).map(x => Number(x.id) || 0)));
  const need = {
    order: mx('orders') + 1, order_num: 1,
    deposit: mx('deposits') + 1, confirmation: mx('confirmations') + 1,
    audit: (d.audit || []).length + 1, payment_num: 1
  };
  for (const k of Object.keys(need)) {
    if (!Number.isInteger(d.seq[k]) || d.seq[k] < need[k]) d.seq[k] = need[k];
  }
}
function audit(d, action, ref_id, by, role) {
  fixSeq(d);
  d.audit.push({ id: d.seq.audit++, action, ref_id, by: by || 'admin', role: role || 'admin', at: now() });
  if (d.audit.length > 500) d.audit = d.audit.slice(-500);
}
function mdata() { return mstore.load(); }
// أشهر ميلادية مع تثبيت آخر الشهر عند التجاوز (31 جانفي + 3 أشهر = 30 أفريل لا 1 ماي)
function plusMonths(base, n) {
  const d = new Date(Date.parse(String(base).slice(0, 10) + 'T00:00:00Z'));
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + Number(n || 0));
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
// الانتهاء الافتراضي للشحنة = تاريخ الوصول + أقصر مدة صلاحية بين مواد الطلبية
// (كل مادة بلا مدة تُعامل كـ 3 أشهر — نفس افتراضي بطاقة الصنف)
function defaultConfExpiry(md, order, arrival) {
  let m = Master.DEFAULT_RAW_SHELF_MONTHS || 3;
  try {
    const vals = (order.lines || []).map(l => Number((md.items.find(i => i.id === Number(l.item_id)) || {}).shelf_months));
    const ok = vals.filter(v => Number.isFinite(v) && v > 0 && v <= 60);
    if (ok.length) m = Math.min.apply(null, ok);
  } catch {}
  return plusMonths(arrival, m);
}
function getSupplier(md, id) {
  const s = md.suppliers.find(x => x.id === Number(id));
  if (!s) err('المورد غير موجود في البيانات الأساسية');
  if (s.active === false) err('المورد موقف — فعّله من البيانات الأساسية أولاً');
  return s;
}
function getItem(md, id) {
  const it = md.items.find(x => x.id === Number(id));
  if (!it) err('المادة غير موجودة في البيانات الأساسية');
  if (it.status === 'متوقفة') err('المادة ' + it.name + ' متوقفة');
  return it;
}
function cleanLines(md, items) {
  if (!Array.isArray(items) || !items.length) err('جدول المواد مطلوب (مادة واحدة على الأقل)');
  const out = [];
  for (const ln of items) {
    const it = getItem(md, ln.item_id);
    // قاعدة المصنع: المشتريات للمواد الأولية والتغليف فقط — المنتج النهائي يُصنع داخلياً ولا يُشترى
    const cat = (md.categories || []).find(c => c.id === Number(it.category_id));
    if (cat && cat.main === 'منتج نهائي') err('ممنوع شراء المنتج النهائي (' + it.name + ') — يُصنع داخل المصنع');
    const qty = toNum(ln.qty, 'كمية ' + it.name);
    const price = toNum(ln.price, 'سعر ' + it.name);
    if (!(qty > 0)) err('كمية ' + it.name + ' يجب أن تكون أكبر من صفر');
    if (price < 0) err('سعر ' + it.name + ' لا يكون سالباً');
    if (out.some(o => o.item_id === it.id)) err('المادة مكررة في الطلبية: ' + it.name);
    out.push({ item_id: it.id, item_name: it.name, unit: it.unit, qty: r2(qty), price: r2(price), total: r2(qty * price) });
  }
  return out;
}
function orderView(d, o) {
  const deps = d.deposits.filter(x => x.order_id === o.id);
  const confs = d.confirmations.filter(x => x.order_id === o.id);
  const cashPaid = r2(deps.filter(x => CASH_METHODS.includes(x.method)).reduce((s, x) => s + Number(x.amount || 0), 0));
  const allPaid = r2(deps.reduce((s, x) => s + Number(x.amount || 0), 0));
  const lines = o.lines.map(ln => {
    const rec = r2(confs.reduce((s, c) => s + Number((c.lines.find(l => l.item_id === ln.item_id) || {}).received_qty || 0), 0));
    return { ...ln, received: rec, remaining: r2(ln.qty - rec) };
  });
  return { ...o, deposits: deps, confirmations: confs, cashPaid, allPaid, lines, total: r2(o.lines.reduce((s, l) => s + Number(l.total || 0), 0)) };
}

const Proc = {
  METHODS, CASH_METHODS,

  meta() {
    const md = mdata();
    const wh = md.warehouses.find(w => w.type === 'مواد أولية') || md.warehouses[0];
    return { data: { methods: METHODS, cash_methods: CASH_METHODS, default_warehouse_id: wh ? wh.id : null, year: new Date().getFullYear() } };
  },

  kpi() {
    const d = db.load();
    const month = now().slice(0, 7);
    const paidMonth = r2(d.deposits.filter(x => CASH_METHODS.includes(x.method) && String(x.date || '').startsWith(month)).reduce((s, x) => s + Number(x.amount || 0), 0));
    const confs = d.confirmations.slice().sort((a, b) => (a.id < b.id ? 1 : -1));
    const last = confs[0] ? d.orders.find(o => o.id === confs[0].order_id) : null;
    // مشتريات الشهر (المواد الأولية المستلمة): الكمية والقيمة من التأكيدات
    let monthQty = 0, monthValue = 0;
    for (const c of (d.confirmations || [])) {
      if (!String(c.arrival_date || '').startsWith(month)) continue;
      monthValue = r2(monthValue + Number(c.received_total || 0));
      for (const l of (c.lines || [])) monthQty = r2(monthQty + Number(l.received_qty || 0));
    }
    return {
      data: {
        pendingApproval: d.orders.filter(o => o.status === 'بانتظار الموافقة').length,
        approvedWaiting: d.orders.filter(o => o.status === 'معتمدة').length,
        depositsMonth: paidMonth,
        monthQty, monthValue,
        lastConfirmed: last ? { num: last.num, date: confs[0].arrival_date, supplier: last.supplier_name } : null,
        partialOpen: d.orders.filter(o => o.status === 'مؤكدة جزئياً').length
      }
    };
  },

  listOrders() {
    const d = db.load();
    return { data: d.orders.slice().sort((a, b) => (a.id < b.id ? 1 : -1)).map(o => orderView(d, o)) };
  },
  getOrder(id) {
    const d = db.load();
    const o = d.orders.find(x => x.id === Number(id));
    if (!o) err('الطلبية غير موجودة', 404);
    return { data: orderView(d, o) };
  },

  addOrder(b, ctx) {
    const md = mdata();
    const sup = getSupplier(md, b.supplier_id);
    const date = validDate(b.date || now().slice(0, 10), 'تاريخ الطلبية');
    const lines = cleanLines(md, b.items);
    const d = db.load();
    fixSeq(d);
    const year = date.slice(0, 4);
    const row = {
      id: d.seq.order++, num: System.formatNum('order', { year, n: d.seq.order_num++ }),
      supplier_id: sup.id, supplier_name: sup.name, date, lines,
      total: r2(lines.reduce((s, l) => s + l.total, 0)),
      status: 'مسودة', reject_reason: '', decided_by: '', decided_at: '',
      created_by: ctx.user, created_at: now(), updated_at: now()
    };
    d.orders.push(row);
    audit(d, 'add-order', row.id, ctx.user, ctx.role);
    db.save(d);
    return { data: orderView(d, row) };
  },
  updateOrder(id, b, ctx) {
    const d = db.load();
    const o = d.orders.find(x => x.id === Number(id));
    if (!o) err('الطلبية غير موجودة', 404);
    if (o.status !== 'مسودة') err('التعديل مسموح في حالة مسودة فقط');
    const md = mdata();
    if (b.supplier_id !== undefined) {
      const sup = getSupplier(md, b.supplier_id);
      o.supplier_id = sup.id; o.supplier_name = sup.name;
    }
    if (b.date !== undefined) o.date = validDate(b.date, 'تاريخ الطلبية');
    if (b.items !== undefined) {
      o.lines = cleanLines(md, b.items);
      o.total = r2(o.lines.reduce((s, l) => s + l.total, 0));
    }
    o.updated_at = now();
    audit(d, 'update-order', o.id, ctx.user, ctx.role);
    db.save(d);
    return { data: orderView(d, o) };
  },
  deleteOrder(id, ctx) {
    const d = db.load();
    const i = d.orders.findIndex(x => x.id === Number(id));
    if (i < 0) err('الطلبية غير موجودة', 404);
    if (d.orders[i].status !== 'مسودة') err('الحذف مسموح في حالة مسودة فقط');
    d.orders.splice(i, 1);
    audit(d, 'delete-order', id, ctx.user, ctx.role);
    db.save(d);
    return { ok: true };
  },
  submitOrder(id, ctx) {
    const d = db.load();
    const o = d.orders.find(x => x.id === Number(id));
    if (!o) err('الطلبية غير موجودة', 404);
    if (o.status !== 'مسودة') err('الإرسال للموافقة من حالة مسودة فقط');
    o.status = 'بانتظار الموافقة';
    o.updated_at = now();
    audit(d, 'submit-order', o.id, ctx.user, ctx.role);
    db.save(d);
    return { data: orderView(d, o) };
  },
  decideOrder(id, b, ctx) {
    if (!Auth.can(ctx.role, 'procurement', 'approve')) err('الموافقة والرفض للمدير فقط', 403);
    const d = db.load();
    const o = d.orders.find(x => x.id === Number(id));
    if (!o) err('الطلبية غير موجودة', 404);
    if (o.status !== 'بانتظار الموافقة') err('القرار من حالة بانتظار الموافقة فقط');
    if (b.decision === 'موافقة') {
      o.status = 'معتمدة'; o.reject_reason = '';
    } else if (b.decision === 'رفض') {
      if (!String(b.reason || '').trim()) err('سبب الرفض مطلوب');
      o.status = 'مرفوضة'; o.reject_reason = String(b.reason).trim();
    } else err('القرار: موافقة أو رفض');
    o.decided_by = ctx.user; o.decided_at = now(); o.updated_at = now();
    audit(d, 'decide-order', o.id, ctx.user, ctx.role);
    db.save(d);
    return { data: orderView(d, o) };
  },

  // ---- كشف المورد: السابقة (افتتاحي + غير مسددة) + الكلي − المدفوع نقدا ----
  statement(order_id, supplier_id) {
    const d = db.load();
    const md = mdata();
    let order = null;
    if (order_id) {
      order = d.orders.find(x => x.id === Number(order_id));
      if (!order) err('الطلبية غير موجودة', 404);
    }
    const sup = md.suppliers.find(x => x.id === Number(order ? order.supplier_id : supplier_id));
    if (!sup) err('المورد غير موجود', 404);
    const opening = toNum(sup.opening_debt, 'الدين الافتتاحي');
    const payPrev = r2(Finance.list().data
      .filter(p => p.supplier_id === sup.id && p.status !== 'مسواة')
      .reduce((s, p) => s + Number(p.amount || 0) - Number(p.settled || 0), 0));
    const prev = r2(opening + payPrev);
    const total = order ? r2(order.total) : 0;
    const cash = order ? r2(d.deposits.filter(x => x.order_id === order.id && CASH_METHODS.includes(x.method)).reduce((s, x) => s + Number(x.amount || 0), 0)) : 0;
    return {
      data: {
        supplier: { id: sup.id, name: sup.name },
        order: order ? { id: order.id, num: order.num, total, status: order.status } : null,
        opening, payables_prev: payPrev, prev_total: prev,
        cash_paid: cash, current: r2(prev + total - cash)
      }
    };
  },

  // ---- نشاط المورد: بطاقة + سجل توريدات ومدفوعات بفترة + ديون سابقة/حالية ----
  // الدفتر: التوريد (تأكيد الاستلام) يرفع الدين، والدفعة النقدية تخفضه — الوعد المؤخر معلومة بلا أثر
  supplierActivity(supplier_id, from, to) {
    const d = db.load();
    const md = mdata();
    const sup = md.suppliers.find(x => x.id === Number(supplier_id));
    if (!sup) err('المورد غير موجود', 404);
    if (from) validDate(from, 'من');
    if (to) validDate(to, 'إلى');
    if (from && to && from > to) err('من أكبر من إلى', 400);
    const inRange = dt => (!from || String(dt || '') >= from) && (!to || String(dt || '') <= to);
    const isCash = m => CASH_METHODS.includes(m);
    const opening = toNum(sup.opening_debt, 'الدين الافتتاحي');
    // الديون السابقة: افتتاحي + توريدات قبل الفترة − مدفوعات نقدية قبل الفترة
    let prevSup = 0, prevPaid = 0;
    for (const c of d.confirmations || []) {
      if (Number(c.supplier_id) !== sup.id) continue;
      if (from && String(c.arrival_date || '') < from) prevSup = r2(prevSup + Number(c.received_total || 0));
    }
    for (const x of d.deposits || []) {
      if (Number(x.supplier_id) !== sup.id) continue;
      if (from && String(x.date || '') < from && isCash(x.method)) prevPaid = r2(prevPaid + Number(x.amount || 0));
    }
    const prev = r2(opening + prevSup - prevPaid);
    // سجل الفترة (أو كل النشاط بلا فترة): توريدات + دفعات مرتبة زمنياً مع رصيد متحرك
    const lines = [];
    for (const c of d.confirmations || []) {
      if (Number(c.supplier_id) !== sup.id || !inRange(c.arrival_date)) continue;
      const goods = (c.lines || []).map(l => l.item_name + ' ' + Number(l.received_qty || 0) + ' ' + (l.unit || '')).join(' + ');
      lines.push({ date: c.arrival_date, kind: 'توريد', ref: c.order_num || '', detail: goods, total: r2(Number(c.received_total || 0)), effect: r2(Number(c.received_total || 0)), _id: 'c' + c.id });
    }
    for (const x of d.deposits || []) {
      if (Number(x.supplier_id) !== sup.id || !inRange(x.date)) continue;
      const cash = isCash(x.method) ? r2(Number(x.amount || 0)) : 0;
      lines.push({ date: x.date, kind: x.method === 'مؤخر' ? 'وعد مؤخر' : 'دفعة', ref: x.order_num || x.num || '', detail: x.method + (x.note ? ' — ' + x.note : ''), total: r2(Number(x.amount || 0)), effect: -cash, _id: 'd' + x.id });
    }
    lines.sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : (a._id < b._id ? -1 : 1)));
    let bal = prev, supTot = 0, paidTot = 0;
    for (const l of lines) {
      if (l.effect > 0) supTot = r2(supTot + l.effect);
      if (l.effect < 0) paidTot = r2(paidTot - l.effect);
      bal = r2(bal + l.effect);
      l.balance = bal;
    }
    // السلعة الموردة: تجميع الكميات والقيم داخل الفترة
    const byItem = {};
    for (const c of d.confirmations || []) {
      if (Number(c.supplier_id) !== sup.id || !inRange(c.arrival_date)) continue;
      for (const l of c.lines || []) {
        const k = l.item_name || ('#' + l.item_id);
        byItem[k] = byItem[k] || { name: k, unit: l.unit || '', qty: 0, total: 0 };
        byItem[k].qty = r2(byItem[k].qty + Number(l.received_qty || 0));
        byItem[k].total = r2(byItem[k].total + Number(l.line_total || 0));
      }
    }
    return {
      data: {
        supplier: {
          id: sup.id, code: sup.code || '', name: sup.name, phone: sup.phone || '', address: sup.address || '',
          kind: sup.kind || 'تجزئة', price_type: sup.price_type || 'تجزئة',
          rc: sup.rc || '', mf: sup.mf || '', art_imp: sup.art_imp || '', nis: sup.nis || '',
          breeder_card: sup.breeder_card || '', bank: sup.bank || ''
        },
        from: from || '', to: to || '',
        prev: { opening, supplies: prevSup, paid: prevPaid, total: prev },
        lines, goods: Object.values(byItem),
        totals: { supplies: supTot, paid: paidTot, current: bal },
        generated_at: new Date().toISOString().slice(0, 16).replace('T', ' ')
      }
    };
  },

  // ---- ملخص كل الموردين: ديون سابقة/حالية + مدفوعات + كميات + توريدات + افتتاحي ----
  // نفس دفتر supplierActivity مطبقاً على كل مورد (الفترة اختيارية) — المرتجعات: لا تدفق مرتجع للموردين بعد (0)
  suppliersSummary(from, to) {
    const d = db.load();
    const md = mdata();
    if (from) validDate(from, 'من');
    if (to) validDate(to, 'إلى');
    if (from && to && from > to) err('من أكبر من إلى', 400);
    const isCash = m => CASH_METHODS.includes(m);
    const rows = [];
    for (const sup of md.suppliers || []) {
      if (sup.active === false) continue;
      const opening = toNum(sup.opening_debt, 'الدين الافتتاحي');
      let prevSup = 0, prevPaid = 0, inSup = 0, inPaid = 0, qty = 0, confs = 0, lastPayDate = '', lastPayAmt = 0;
      for (const c of d.confirmations || []) {
        if (Number(c.supplier_id) !== sup.id) continue;
        const dt = String(c.arrival_date || '');
        if (from && dt < from) { prevSup = r2(prevSup + Number(c.received_total || 0)); continue; }
        if (to && dt > to) continue;
        inSup = r2(inSup + Number(c.received_total || 0));
        confs++;
        for (const l of c.lines || []) qty = r2(qty + Number(l.received_qty || 0));
      }
      for (const x of d.deposits || []) {
        if (Number(x.supplier_id) !== sup.id || !isCash(x.method)) continue;
        const amt = r2(Number(x.amount || 0));
        const dt = String(x.date || '');
        if (from && dt < from) { prevPaid = r2(prevPaid + amt); continue; }
        if (to && dt > to) continue;
        inPaid = r2(inPaid + amt);
        if (!lastPayDate || dt >= lastPayDate) { lastPayDate = dt; lastPayAmt = amt; }
      }
      const prev = r2(opening + prevSup - prevPaid);
      rows.push({
        supplier_id: sup.id, code: sup.code || '', name: sup.name,
        opening, prev, paid: inPaid, current: r2(prev + inSup - inPaid),
        total_qty: qty, conf_count: confs, returns: 0,
        last_pay_date: lastPayDate, last_pay_amount: lastPayAmt
      });
    }
    rows.sort((a, b) => b.current - a.current);
    const tot = rows.reduce((s, r) => ({ prev: r2(s.prev + r.prev), paid: r2(s.paid + r.paid), current: r2(s.current + r.current), qty: r2(s.qty + r.total_qty), confs: s.confs + r.conf_count }), { prev: 0, paid: 0, current: 0, qty: 0, confs: 0 });
    return { data: { from: from || '', to: to || '', rows, totals: tot, has_returns_flow: false, generated_at: new Date().toISOString().slice(0, 16).replace('T', ' ') } };
  },

  // ---- العربون ----
  listDeposits(order_id) {
    const d = db.load();
    const rows = (order_id ? d.deposits.filter(x => x.order_id === Number(order_id)) : d.deposits).slice().sort((a, b) => (a.id < b.id ? 1 : -1));
    return { data: rows };
  },
  _depLock(d, order_id) {
    if (d.confirmations.some(c => c.order_id === Number(order_id))) err('مقفل: بدأ تأكيد الطلبية المرتبطة — لا إضافة ولا تعديل ولا حذف للعربون');
  },
  addDeposit(b, ctx) {
    if (!Auth.can(ctx.role, 'procurement', 'deposit')) err('العربون: المحاسب أو المدير فقط', 403);
    const d = db.load();
    fixSeq(d);
    const o = d.orders.find(x => x.id === Number(b.order_id));
    if (!o) err('الطلبية غير موجودة', 404);
    if (o.status !== 'معتمدة' && o.status !== 'مؤكدة جزئياً') err('العربون للطلبيات المعتمدة فقط');
    this._depLock(d, o.id);
    if (!METHODS.includes(b.method)) err('طريقة الدفع: ' + METHODS.join(' / '));
    const amount = toNum(b.amount, 'المبلغ المدفوع');
    if (b.method === 'مؤخر') {
      if (amount !== 0) err('المؤخر وعد لا دفع — المبلغ صفر إجباري');
    } else if (!(amount > 0)) err('المبلغ يجب أن يكون أكبر من صفر');
    if (CASH_METHODS.includes(b.method)) {
      const paid = r2(d.deposits.filter(x => x.order_id === o.id && CASH_METHODS.includes(x.method)).reduce((s, x) => s + Number(x.amount || 0), 0));
      if (r2(paid + amount) > r2(o.total) + 1e-9) err('تجاوز إجمالي الطلبية (' + o.total + ') — المدفوع نقدا ' + paid + ' والمسموح المتبقي ' + r2(o.total - paid));
    }
    // الحساب صريح اختياري (يُثبَّت في الدفتر بدل تخمين أول صندوق/بنك — حاسم مع تعدد الصناديق)
    let account = '';
    if (b.account !== undefined && b.account !== null && String(b.account).trim() !== '') {
      const accs = require('./finance').listAccounts().data;
      const acc = accs.find(a => a.name === String(b.account).trim());
      if (!acc) err('حساب الدفع غير موجود — اختره من القائمة');
      account = acc.name;
    }
    const row = {
      id: d.seq.deposit++, order_id: o.id, order_num: o.num,
      supplier_id: o.supplier_id, supplier_name: o.supplier_name,
      date: validDate(b.date || now().slice(0, 10), 'التاريخ'),
      method: b.method, amount: r2(amount), account, note: String(b.note || '').trim().slice(0, 200),
      created_by: ctx.user, created_at: now()
    };
    d.deposits.push(row);
    audit(d, 'add-deposit', row.id, ctx.user, ctx.role);
    db.save(d);
    return { data: row };
  },
  updateDeposit(id, b, ctx) {
    if (!Auth.can(ctx.role, 'procurement', 'deposit')) err('العربون: المحاسب أو المدير فقط', 403);
    const d = db.load();
    const r = d.deposits.find(x => x.id === Number(id));
    if (!r) err('غير موجود', 404);
    this._depLock(d, r.order_id);
    if (b.date !== undefined) r.date = validDate(b.date, 'التاريخ');
    if (b.method !== undefined) {
      if (!METHODS.includes(b.method)) err('طريقة الدفع: ' + METHODS.join(' / '));
      r.method = b.method;
    }
    if (b.amount !== undefined) r.amount = r2(toNum(b.amount, 'المبلغ المدفوع'));
    if (r.method === 'مؤخر' && r.amount !== 0) err('المؤخر وعد لا دفع — المبلغ صفر إجباري');
    if (r.method !== 'مؤخر' && !(r.amount > 0)) err('المبلغ يجب أن يكون أكبر من صفر');
    if (b.note !== undefined) r.note = String(b.note || '').trim().slice(0, 200);
    if (b.account !== undefined) {
      if (b.account === null || String(b.account).trim() === '') r.account = '';
      else {
        const accs = require('./finance').listAccounts().data;
        const acc = accs.find(a => a.name === String(b.account).trim());
        if (!acc) err('حساب الدفع غير موجود — اختره من القائمة');
        r.account = acc.name;
      }
    }
    if (CASH_METHODS.includes(r.method)) {
      const o = d.orders.find(x => x.id === r.order_id);
      const paid = r2(d.deposits.filter(x => x.order_id === r.order_id && x.id !== r.id && CASH_METHODS.includes(x.method)).reduce((s, x) => s + Number(x.amount || 0), 0));
      if (r2(paid + r.amount) > r2(o.total) + 1e-9) err('تجاوز إجمالي الطلبية (' + o.total + ') — المسموح المتبقي ' + r2(o.total - paid));
    }
    audit(d, 'update-deposit', r.id, ctx.user, ctx.role);
    db.save(d);
    return { data: r };
  },
  deleteDeposit(id, ctx) {
    if (!Auth.can(ctx.role, 'procurement', 'deposit')) err('العربون: المحاسب أو المدير فقط', 403);
    const d = db.load();
    const i = d.deposits.findIndex(x => x.id === Number(id));
    if (i < 0) err('غير موجود', 404);
    this._depLock(d, d.deposits[i].order_id);
    d.deposits.splice(i, 1);
    audit(d, 'delete-deposit', id, ctx.user, ctx.role);
    db.save(d);
    return { ok: true };
  },

  // ---- دفعة مستقلة لمورد: بلا طلبية/توريد (تسديد دين افتتاحي أو قديم، أو عربون حر) ----
  // تدخل الكشوفات والديون والدفتر تلقائياً عبر supplier_id (الدفع الزائد = دائن لصالحك)
  addPayment(b, ctx) {
    if (!Auth.can(ctx.role, 'procurement', 'deposit')) err('الدفعات: المحاسب أو المدير فقط', 403);
    const md = mdata();
    const sup = getSupplier(md, b.supplier_id);
    const payType = b.pay_type === 'عربون' ? 'عربون' : 'دفع لمورد';
    if (b.method !== 'نقدي' && b.method !== 'شيك') err('طريقة الدفع: نقدي / شيك');
    const amount = toNum(b.amount, 'المبلغ');
    if (!(amount > 0)) err('المبلغ يجب أن يكون أكبر من صفر');
    const date = validDate(b.date || now().slice(0, 10), 'التاريخ');
    // الحساب صريح وإجباري، مطابق للطريقة، برصيد كافٍ (منع صارم — لا CPA سالبة)
    const accs = Finance.listAccounts().data;
    const acc = accs.find(a => a.name === String(b.account || '').trim());
    if (!acc) err('حدد الصندوق/البنك الذي تمت منه العملية');
    if (b.method === 'نقدي' && acc.type !== 'صندوق') err('الدفع النقدي من صندوق فقط');
    if (b.method === 'شيك' && acc.type !== 'بنك') err('الشيك من بنك فقط');
    if (!(Number(acc.balance || 0) >= amount - 1e-9)) err('رصيد «' + acc.name + '» غير كافٍ (المتاح ' + Number(acc.balance || 0) + ') — غذِّه بتحويل أولاً');
    // الشيك: تفاصيل إجبارية (تظهر تلقائياً في الواجهة)
    let check = null;
    if (b.method === 'شيك') {
      const c = (b.check && typeof b.check === 'object') ? b.check : {};
      const number = String(c.number || '').trim();
      const bank = String(c.bank || '').trim();
      const owner = String(c.owner || '').trim();
      if (!number) err('رقم الشيك مطلوب');
      if (!bank) err('اسم البنك مطلوب');
      if (!owner) err('اسم صاحب الشيك مطلوب');
      const issue = validDate(c.issue_date, 'تاريخ إصدار الشيك');
      const due = validDate(c.due_date, 'تاريخ استحقاق الشيك');
      if (due < issue) err('تاريخ الاستحقاق بعد الإصدار');
      check = { number: number.slice(0, 30), bank: bank.slice(0, 60), issue_date: issue, due_date: due, owner: owner.slice(0, 60), note: String(c.note || '').trim().slice(0, 200) };
    }
    const d = db.load();
    fixSeq(d);
    const pat = (((System.get() || {}).numbering) || {}).payment || '';
    const n = d.seq.payment_num;
    const num = (pat && pat.includes('{NNN}'))
      ? pat.replace('{YYYY}', String(new Date(date).getFullYear())).replace(/\{N+\}/, m => String(n).padStart(m.length - 2, '0'))
      : 'PAY-' + String(new Date(date).getFullYear()) + '-' + String(n).padStart(3, '0');
    d.seq.payment_num++;
    const row = {
      id: d.seq.deposit++, num, order_id: null, order_num: '',
      supplier_id: sup.id, supplier_name: sup.name, pay_type: payType,
      date, method: b.method, amount: r2(amount), account: acc.name, check,
      note: String(b.note || '').trim().slice(0, 200),
      created_by: ctx.user, created_at: now()
    };
    d.deposits.push(row);
    audit(d, 'add-payment', row.id, ctx.user, ctx.role);
    db.save(d);
    return { data: row };
  },

  // ---- التأكيد ----
  // كود التأكيد (وصول التسليم): حتمي من المعرف والسنة — CF-YYYY-NNN بلا تخزين
  confNum(c) {
    const y = String((c && c.arrival_date) || '').slice(0, 4) || String(new Date().getFullYear());
    return 'CF-' + y + '-' + String((c && c.id) || 0).padStart(3, '0');
  },
  listConfirmations(order_id) {
    const d = db.load();
    const rows = (order_id ? d.confirmations.filter(x => x.order_id === Number(order_id)) : d.confirmations).slice().sort((a, b) => (a.id < b.id ? 1 : -1));
    return { data: rows.map(c => Object.assign({}, c, { num: this.confNum(c) })) };
  },
  getConfirmation(id) {
    const d = db.load();
    const c = d.confirmations.find(x => x.id === Number(id));
    if (!c) err('غير موجود', 404);
    return { data: Object.assign({}, c, { num: this.confNum(c) }) };
  },
  addConfirmation(b, ctx) {
    if (!Auth.can(ctx.role, 'procurement', 'confirm')) err('التأكيد: أمين المخزن أو المدير فقط', 403);
    const md = mdata();
    const d = db.load();
    fixSeq(d);
    const o = d.orders.find(x => x.id === Number(b.order_id));
    if (!o) err('الطلبية غير موجودة', 404);
    if (o.status !== 'معتمدة' && o.status !== 'مؤكدة جزئياً') err('التأكيد للطلبية المعتمدة فقط (بعد موافقة المدير)');
    // عدم تكرار: مفتاح العميل يمنع تأكيداً مزدوجاً (نقر مزدوج/إعادة إرسال بعد نجاح ضائع الرد)
    const ckey = String((b && b.client_key) || '').trim().slice(0, 40);
    if (ckey) {
      const dup = d.confirmations.find(c => c.order_id === o.id && String(c.client_key || '') === ckey);
      if (dup) return { data: dup, deduped: true };
    }
    const arrival = validDate(b.arrival_date || now().slice(0, 10), 'تاريخ الوصول');
    const wh = md.warehouses.find(w => w.id === Number(b.warehouse_id)) || md.warehouses.find(w => w.type === 'مواد أولية') || md.warehouses[0];
    if (!wh) err('لا يوجد مخزن — عرّف المخازن أولاً');
    // المشتريات تستلم في مخازن المواد الأولية فقط — المنتج النهائي ينتجه قسم الإنتاج
    if (wh.type === 'منتج نهائي') err('الاستلام في مخازن المواد الأولية فقط (' + wh.name + ' مخزن منتج نهائي)');
    // تاريخ الانتهاء اختياري: فارغ = تلقائي (الوصول + مدة صلاحية الأصناف، افتراضياً 3 أشهر)
    const expiry = (b.expiry !== undefined && b.expiry !== null && String(b.expiry).trim() !== '')
      ? validDate(b.expiry, 'تاريخ انتهاء الشحنة')
      : defaultConfExpiry(md, o, arrival);
    // الكميات مقابل المتبقي
    const prev = {};
    for (const c of d.confirmations.filter(x => x.order_id === o.id)) {
      for (const l of c.lines) prev[l.item_id] = r2((prev[l.item_id] || 0) + Number(l.received_qty || 0));
    }
    if (!Array.isArray(b.lines) || !b.lines.length) err('جدول المقارنة مطلوب');
    const lines = [];
    for (const ln of b.lines) {
      const ol = o.lines.find(l => l.item_id === Number(ln.item_id));
      if (!ol) err('مادة خارج الطلبية الأصلية');
      const rec = toNum(ln.received_qty, 'المستلم من ' + ol.item_name);
      if (rec < 0) err('المستلم لا يكون سالباً');
      const remain = r2(ol.qty - (prev[ol.item_id] || 0));
      if (rec > remain + 1e-9) err('المستلم من ' + ol.item_name + ' يتجاوز المتبقي (' + remain + ')');
      const price = toNum(ln.price !== undefined ? ln.price : ol.price, 'سعر ' + ol.item_name);
      if (price < 0) err('السعر لا يكون سالباً');
      lines.push({ item_id: ol.item_id, item_name: ol.item_name, unit: ol.unit, ordered_qty: ol.qty, received_qty: r2(rec), price: r2(price), line_total: r2(rec * price) });
    }
    if (!lines.some(l => l.received_qty > 0)) err('أدخل كمية مستلمة واحدة على الأقل');
    // الجودة: مقبولة أو تمرير استثنائي مسجل
    const qc = b.qc || {};
    if (!['مقبولة', 'تمرير استثنائي'].includes(qc.result)) err('نتيجة الفحص: مقبولة أو تمرير استثنائي');
    if (qc.result === 'تمرير استثنائي' && (!String(qc.note || '').trim() || !String(qc.by || '').trim())) {
      err('التمرير الاستثنائي يتطلب الملاحظة واسم المصرح');
    }
    // هل اكتملت؟
    const fullAfter = o.lines.every(ol => r2(ol.qty - (prev[ol.item_id] || 0) - Number((lines.find(l => l.item_id === ol.item_id) || {}).received_qty || 0)) <= 1e-9);
    const invoice_ref = String(b.invoice_ref || '').trim();
    if (fullAfter && !invoice_ref) err('مرجع الفاتورة/وصل التسليم إلزامي عند التأكيد الكامل');
    // الحسابات: النقدي الفعلي فقط يخصم — مع توزيع العربون على التأكيدات الجزئية دون ازدواج
    // (إصلاح: سابقاً كان كل تأكيد يخصم كامل العربون فينتقص المستحق)
    const received_total = r2(lines.reduce((s, l) => s + l.line_total, 0));
    const cashPaidTotal = r2(d.deposits.filter(x => x.order_id === o.id && CASH_METHODS.includes(x.method)).reduce((s, x) => s + Number(x.amount || 0), 0));
    const prevDeducted = r2(d.confirmations.filter(x => x.order_id === o.id).reduce((s, c) => s + Number(c.cash_deducted || 0), 0));
    const remainingCash = r2(cashPaidTotal - prevDeducted);
    const cashDeducted = r2(Math.max(0, Math.min(received_total, remainingCash)));
    const payable = r2(received_total - cashDeducted);
    const row = {
      id: d.seq.confirmation++, order_id: o.id, order_num: o.num,
      supplier_id: o.supplier_id, supplier_name: o.supplier_name,
      arrival_date: arrival, warehouse_id: wh.id, warehouse_name: wh.name, expiry,
      lines, invoice_ref,
      qc: { result: qc.result, note: String(qc.note || '').trim(), by: String(qc.by || ctx.user).trim() },
      received_total, cash_deducted: cashDeducted, payable,
      client_key: ckey || undefined,
      status: fullAfter ? 'مؤكدة بالكامل' : 'مؤكدة جزئياً',
      confirmed_by: ctx.user, created_at: now()
    };
    d.confirmations.push(row);
    // الآثار التلقائية ذرياً قدر الإمكان: (1) لوتات (2) آخر سعر (3) مستحق
    // عند فشل منتصف الطريق يُسترجع ما أُضيف (تعويض) بدل ترك لوتات يتيمة
    const createdLotIds = [];
    try {
      for (const l of lines) {
        if (l.received_qty > 0) {
          const lot = Stock.receiveLot({ item_id: l.item_id, item_name: l.item_name, unit: l.unit, qty: l.received_qty, cost: l.price, warehouse_id: wh.id, warehouse_name: wh.name, expiry, qc: qc.result, order_num: o.num, supplier_id: o.supplier_id, supplier_name: o.supplier_name, date: arrival, user: ctx.user });
          if (lot && lot.id != null) createdLotIds.push(lot.id);
          Master.updateItem(l.item_id, { last_price: l.price }, ctx);
        }
      }
      Finance.addPayable({ order_id: o.id, order_num: o.num, supplier_id: o.supplier_id, supplier_name: o.supplier_name, amount: payable, date: arrival, note: 'تأكيد ' + row.status });
    } catch (e) {
      // تعويض: احذف اللوتات المضافة في هذا التأكيد الفاشل
      try {
        const invDb = require('./jstore')('inventory.json', { lots: [], movements: [] });
        const id = invDb.load();
        const ids = new Set(createdLotIds);
        id.lots = (id.lots || []).filter(l => !ids.has(l.id));
        id.movements = (id.movements || []).filter(m => !(m.lot_id != null && ids.has(m.lot_id)));
        invDb.save(id);
      } catch (e2) {}
      // أخرج التأكيد نفسه من الذاكرة قبل الحفظ
      d.confirmations = d.confirmations.filter(c => c.id !== row.id);
      d.seq.confirmation = Math.max(1, d.seq.confirmation - 1);
      o.status = 'معتمدة';
      throw e;
    }
    o.status = fullAfter ? 'مؤكدة بالكامل' : 'مؤكدة جزئياً';
    o.updated_at = now();
    audit(d, 'confirm-order', o.id, ctx.user, ctx.role);
    db.save(d);
    return { data: row };
  }
};

module.exports = Proc;

// المبيعات: فاتورة SI ← تأكيد بخصم FEFO للمنتج التام + دين ← تحصيل ← مرتجع للمخزون
// القواعد: المسودة بلا أثر — المؤكدة تُصحح بالمرتجع فقط — النقد قابل للتعديل
const jstore = require('./jstore');
const System = require('./system');
const Auth = require('./auth');
const mstore = require('./store');
const Stock = require('./stock');
const Finance = require('./finance');

const db = jstore('sales.json', {
  seq: { invoice: 1, invoice_num: 1, receipt: 1, receipt_num: 1, ret: 1, ret_num: 1, cmdorder: 1, cmdorder_num: 1 },
  invoices: [], receipts: [], returns: [], cmdorders: []
});
const now = () => new Date().toISOString();
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const METHODS = ['نقدي', 'تحويل بنكي', 'شيك', 'مؤخر'];
const RETURN_REASONS = ['عيب', 'خطأ', 'انتهاء', 'أخرى'];

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
function mdata() { return mstore.load(); }
// حساب القبض: النقد في صندوق مسمى، والتحويل/الشيك في بنك مسمى — موجود ومعرف في المالية
function checkReceiptAccount(method, account) {
  const name = String(account || '').trim();
  if (!name) err(method === 'نقدي' ? 'اختر الصندوق لاستلام النقد' : 'اختر البنك — عرّفه في المالية أولاً');
  const accs = Finance.listAccounts().data;
  const acc = accs.find(a => a.name === name);
  if (!acc) err('الحساب «' + name + '» غير موجود — عرّفه في المالية أولاً');
  const want = method === 'نقدي' ? 'صندوق' : 'بنك';
  if (acc.type !== want) err('«' + name + '» حساب ' + acc.type + ' — القبض ' + (method === 'نقدي' ? 'النقدي في صندوق' : 'البنكي في بنك'));
  return acc.name;
}
function getCustomer(md, id) {
  const c = md.customers.find(x => x.id === Number(id));
  if (!c) err('الزبون غير موجود في البيانات الأساسية');
  if (c.active === false) err('الزبون موقف — فعّله من البيانات الأساسية أولاً');
  return c;
}
function getProduct(md, id) {
  const it = md.items.find(x => x.id === Number(id));
  if (!it) err('المنتج غير موجود في البيانات الأساسية');
  if (it.status === 'متوقفة') err('المنتج ' + it.name + ' موقف');
  const cat = (md.categories || []).find(c => c.id === Number(it.category_id));
  if (!cat || cat.main !== 'منتج نهائي') {
    err('البيع للمنتج النهائي فقط: ' + it.name + ' مصنفة «' + (cat ? cat.main : 'بلا تصنيف') + '» — المواد الأولية لا تباع');
  }
  return it;
}
function cleanLines(md, items) {
  if (!Array.isArray(items) || !items.length) err('سطور الفاتورة مطلوبة (منتج واحد على الأقل)');
  const out = [];
  for (const ln of items) {
    const it = getProduct(md, ln.item_id);
    const qty = toNum(ln.qty, 'كمية ' + it.name);
    const price = toNum(ln.price, 'سعر ' + it.name);
    if (!(qty > 0)) err('كمية ' + it.name + ' أكبر من صفر');
    if (price < 0) err('السعر لا يكون سالباً');
    if (out.some(o => o.item_id === it.id)) err('المنتج مكرر في الفاتورة: ' + it.name);
    out.push({ item_id: it.id, item_name: it.name, unit: it.unit, qty: r2(qty), price: r2(price), total: r2(qty * price) });
  }
  return out;
}
// صافي الفاتورة: الإجمالي − المحصل − المرتجع بسعر البيع الأصلي
function invoiceView(d, inv) {
  const receipts = d.receipts.filter(x => x.invoice_id === inv.id);
  const returns = d.returns.filter(x => x.invoice_id === inv.id);
  const paid = r2(receipts.reduce((s, x) => s + Number(x.amount || 0), 0));
  let retVal = 0;
  for (const rt of returns) {
    for (const l of rt.lines) {
      const ol = inv.lines.find(x => x.item_id === l.item_id);
      retVal = r2(retVal + Number(l.qty || 0) * Number(ol ? ol.price : 0));
    }
  }
  return { ...inv, receipts, returns, paid, retVal, remaining: r2(inv.total - paid - retVal) };
}

const Sales = {
  METHODS, RETURN_REASONS,

  // توافر البيع: المتبقي القابل للبيع + تكلفة الإنتاج لكل منتج تام (مخازن التام فقط، المقبول فقط)
  availability() {
    const md = mdata();
    const finIds = new Set((md.items || []).filter(it => {
      const c = (md.categories || []).find(x => x.id === Number(it.category_id));
      return c && c.main === 'منتج نهائي';
    }).map(it => it.id));
    const finWh = new Set((md.warehouses || []).filter(w => w.type === 'منتج نهائي').map(w => w.id));
    let lots = [];
    try { lots = require('./jstore')('inventory.json', { lots: [] }).load().lots || []; } catch { lots = []; }
    const map = {};
    for (const l of lots) {
      if (!finIds.has(Number(l.item_id)) || !finWh.has(Number(l.warehouse_id))) continue;
      const rem = r2(Number(l.remaining || 0));
      if (!(rem > 0)) continue;
      const qf = l.qc_final || (l.qc === 'تمرير استثنائي' ? 'بانتظار المراجعة' : (l.qc || 'مقبولة'));
      if (qf !== 'مقبولة') continue;
      const k = Number(l.item_id);
      if (!map[k]) {
        const it = (md.items || []).find(x => x.id === k) || {};
        map[k] = { item_id: k, item_name: l.item_name, unit: l.unit || it.unit || '', remaining: 0, value: 0 };
      }
      map[k].remaining = r2(map[k].remaining + rem);
      map[k].value = r2(map[k].value + rem * Number(l.cost_per_unit || 0));
    }
    return {
      data: Object.values(map).map(r => ({
        item_id: r.item_id, item_name: r.item_name, unit: r.unit,
        remaining: r.remaining, unit_cost: r.remaining > 0 ? r2(r.value / r.remaining) : 0
      }))
    };
  },

  kpi() {
    const d = db.load();
    const conf = d.invoices.filter(o => o.status === 'مؤكدة');
    const t = now().slice(0, 10), month = t.slice(0, 7);
    const sumT = arr => r2(arr.reduce((s, o) => s + Number(o.total || 0), 0));
    const sumQ = arr => r2(arr.reduce((s, o) => s + (o.lines || []).reduce((a, l) => a + Number(l.qty || 0), 0), 0));
    let recv = 0;
    for (const o of conf) recv = r2(recv + invoiceView(d, o).remaining);
    return {
      data: {
        today: sumT(conf.filter(o => o.date === t)),
        todayQty: sumQ(conf.filter(o => o.date === t)),
        month: sumT(conf.filter(o => String(o.date).startsWith(month))),
        receivables: recv,
        last: conf.slice().sort((a, b) => (a.id < b.id ? 1 : -1))[0] || null,
        returnsMonth: d.returns.filter(x => String(x.date).startsWith(month)).length
      }
    };
  },

  statement(invoice_id, customer_id) {
    const d = db.load();
    const md = mdata();
    let inv = null;
    if (invoice_id) {
      inv = d.invoices.find(x => x.id === Number(invoice_id));
      if (!inv) err('الفاتورة غير موجودة', 404);
    }
    const cust = md.customers.find(x => x.id === Number(inv ? inv.customer_id : customer_id));
    if (!cust) err('الزبون غير موجود', 404);
    const opening = toNum(cust.opening_debt, 'الدين الافتتاحي');
    const open = d.invoices.filter(x => x.customer_id === cust.id && x.status === 'مؤكدة');
    let invTotal = 0, paid = 0, ret = 0;
    for (const o of open) {
      const v = invoiceView(d, o);
      invTotal = r2(invTotal + o.total); paid = r2(paid + v.paid); ret = r2(ret + v.retVal);
    }
    return {
      data: {
        customer: { id: cust.id, name: cust.name },
        invoice: inv ? { id: inv.id, num: inv.num, total: inv.total } : null,
        opening, invoices_total: invTotal, paid, returns: ret,
        net: r2(opening + invTotal - paid - ret)
      }
    };
  },

  // نطاق المندوب: فواتيره وتحصيلاته ومرتجعاته فقط (البقية: 403 دون كشف الوجود)
  _own(d, ctx, id) {
    const o = d.invoices.find(x => x.id === Number(id));
    if (!o) err('الفاتورة غير موجودة', 404);
    if (ctx.role === 'salesman' && o.created_by !== ctx.user) err('فواتيرك فقط — هذه لزميل آخر', 403);
    return o;
  },
  _scopeRows(rows, ctx) {
    if ((ctx || {}).role !== 'salesman') return rows;
    return (rows || []).filter(x => x.created_by === ctx.user);
  },
  _mine(row, ctx, what) {
    if (ctx.role === 'salesman' && row && row.created_by !== ctx.user) err((what || 'هذا السجل') + ': خاص بزميل آخر', 403);
    return row;
  },
  listInvoices(ctx) {
    const d = db.load();
    const rows = this._scopeRows(d.invoices, ctx).slice().sort((a, b) => (a.id < b.id ? 1 : -1));
    return { data: rows.map(o => invoiceView(d, o)) };
  },
  getInvoice(id, ctx) {
    const d = db.load();
    return { data: invoiceView(d, this._own(d, ctx, id)) };
  },
  addInvoice(b, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الفواتير: المدير أو المحاسب فقط', 403);
    const md = mdata();
    const cust = getCustomer(md, b.customer_id);
    const lines = cleanLines(md, b.items);
    const d = db.load();
    const date = validDate(b.date || now().slice(0, 10), 'التاريخ');
    const row = {
      id: d.seq.invoice++, num: System.formatNum('invoice', { year: date.slice(0, 4), n: d.seq.invoice_num++ }),
      customer_id: cust.id, customer_name: cust.name, date, lines,
      total: r2(lines.reduce((s, l) => s + l.total, 0)),
      destination: String(b.destination || '').trim().slice(0, 120),
      driver: String(b.driver || '').trim().slice(0, 120),
      delivery_date: b.delivery_date ? validDate(b.delivery_date, 'تاريخ التسليم') : '',
      status: 'مسودة', note: String(b.note || '').trim(),
      created_by: ctx.user, created_at: now(), updated_at: now()
    };
    d.invoices.push(row);
    db.save(d);
    // فوترة تلقائية: وصل مؤقت + فاتورة مؤقتة (لا تكسر الإنشاء عند تعذرها)
    try { require('./billing').onInvoiceCreated(row, ctx); } catch {}
    return { data: invoiceView(d, row) };
  },
  updateInvoice(id, b, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الفواتير: المدير أو المحاسب فقط', 403);
    const d = db.load();
    const o = d.invoices.find(x => x.id === Number(id));
    if (!o) err('الفاتورة غير موجودة', 404);
    if (o.status !== 'مسودة') err('التعديل في مسودة فقط — المؤكدة تُصحح بالمرتجع');
    this._mine(o, ctx, 'الفاتورة');
    const md = mdata();
    if (b.customer_id !== undefined) {
      const cust = getCustomer(md, b.customer_id);
      o.customer_id = cust.id; o.customer_name = cust.name;
    }
    if (b.date !== undefined) o.date = validDate(b.date, 'التاريخ');
    if (b.delivery_date !== undefined) o.delivery_date = validDate(b.delivery_date, 'تاريخ التسليم');
    if (b.items !== undefined) {
      o.lines = this._cmdLines(md, b.items);
      o.total = r2(o.lines.reduce((s, l) => s + l.total, 0));
    }
    if (b.note !== undefined) o.note = String(b.note || '').trim();
    if (b.destination !== undefined) o.destination = String(b.destination || '').trim().slice(0, 120);
    if (b.driver !== undefined) o.driver = String(b.driver || '').trim().slice(0, 120);
    if (b.delivery_date !== undefined) o.delivery_date = String(b.delivery_date || '').trim() ? validDate(b.delivery_date, 'تاريخ التسليم') : '';
    o.updated_at = now();
    db.save(d);
    try { require('./billing').onInvoiceUpdated(o); } catch {}
    return { data: invoiceView(d, o) };
  },
  deleteInvoice(id, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الفواتير: المدير أو المحاسب فقط', 403);
    const d = db.load();
    const i = d.invoices.findIndex(x => x.id === Number(id));
    if (i < 0) err('الفاتورة غير موجودة', 404);
    if (d.invoices[i].status !== 'مسودة') err('الحذف في مسودة فقط');
    this._mine(d.invoices[i], ctx, 'الفاتورة');
    const goneId = d.invoices[i].id;
    d.invoices.splice(i, 1);
    // فك الارتباط: أي طلبية محولة لهذه الفاتورة تعود موثقة قابلة للتعديل/التحويل من جديد
    // (بدون هذا تُترك الطلبية تشير لفاتورة شبح: لا عرض ولا حذف ولا تصحيح)
    let unconverted = 0;
    for (const c of (d.cmdorders || [])) {
      if (Number(c.invoice_id) === Number(goneId)) {
        c.status = 'موثقة'; c.invoice_id = null; c.invoice_num = ''; c.updated_at = now();
        unconverted++;
      }
    }
    db.save(d);
    try { require('./billing').onInvoiceDeleted(goneId); } catch {}
    return { ok: true, unconverted };
  },
  confirmInvoice(id, b, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('التأكيد: المدير أو المحاسب فقط', 403);
    const md = mdata();
    const d = db.load();
    const o = d.invoices.find(x => x.id === Number(id));
    if (!o) err('الفاتورة غير موجودة', 404);
    if (o.status !== 'مسودة') err('التأكيد من مسودة فقط');
    this._mine(o, ctx, 'الفاتورة');
    for (const ln of o.lines) getProduct(md, ln.item_id); // إعادة التحقق لحظة البيع (قد تكون أُعيد تصنيفها بعد المسودة)
    // منع الخصم المزدوج: أي خروج سابق لهذه الفاتورة يعني تأكيداً سابقاً (نقر مزدوج/إعادة محاولة)
    try {
      const invDb = require('./jstore')('inventory.json', { lots: [], movements: [] });
      const prior = ((invDb.load().movements) || []).some(m => m.type === 'خروج' && m.source && m.source.kind === 'فاتورة' && String(m.source.num || '') === String(o.num || ''));
      if (prior) err('صُرفت هذه الفاتورة مسبقاً (' + o.num + ') — التأكيد المكرر مرفوض لمنع الخصم المزدوج', 409);
    } catch (e) { if (e && e.code === 409) throw e; }
    const inv = require('./inventory-check');
    // خصم FEFO الشامل لكل مخازن التام + لقطة التكلفة لكل سطر (مطابق لرقم التوافر المعروض)
    for (const ln of o.lines) {
      const taken = inv.consumeMulti([{ item_id: ln.item_id, qty: ln.qty }], { kind: 'فاتورة', num: o.num }, ctx.user, 'بيع ' + o.num, ['منتج نهائي']);
      const val = r2(taken.reduce((s, c) => s + c.value, 0));
      ln.cost_snapshot = r2(val / ln.qty);
      ln.margin = r2((ln.price - ln.cost_snapshot) * ln.qty);
    }
    o.warehouse_id = null; o.warehouse_name = 'تلقائي (مخازن التام)';
    // أكياس البيع (معيار المصنع 2/قنطار): تُخصم تلقائياً من مخازن الخام
    // تحذير عند النقص دون منع البيع — المنتج مغلّف فعلياً وثمن الأكياس في التكلفة النهائية
    const bagIt = inv.bagsItem ? inv.bagsItem() : null;
    const bagPerQ = inv.BAGS_PER_Q || 2;
    o.bags = { item_id: bagIt ? bagIt.id : null, item_name: bagIt ? bagIt.name : '', unit: bagIt ? bagIt.unit : '', per_q: bagPerQ, qty: 0, shortfall: 0, skipped: !bagIt };
    if (bagIt) {
      let need = 0;
      for (const ln of o.lines) need += Math.ceil(Number(ln.qty || 0) * bagPerQ - 1e-9);
      if (need > 0) {
        const res = inv.consumeUpTo(bagIt.id, need, { kind: 'فاتورة', num: o.num }, ctx.user, 'أكياس البيع — ' + o.num, ['مواد أولية']);
        o.bags.qty = res.took; o.bags.shortfall = res.shortfall;
      }
    }
    o.status = 'مؤكدة'; o.confirmed_by = ctx.user; o.confirmed_at = now(); o.updated_at = now();
    Finance.addReceivable({ invoice_id: o.id, invoice_num: o.num, customer_id: o.customer_id, customer_name: o.customer_name, amount: o.total, date: o.date, note: 'فاتورة بيع' });
    db.save(d);
    // الوصل النهائي تلقائي مع كل تأكيد بيع (إثبات التسليم — نسخة للزبون ونسخة للأرشيف)
    try { require('./billing').onInvoiceConfirmed(o, ctx); } catch {}
    return { data: invoiceView(d, o) };
  },

  // ---- طلبيات الزبائن: مرحلة خفيفة قبل البيع (طلب/حجز بلا أي أثر مخزني أو مالي) ----
  // مسودة ← موثقة ← محولة لفاتورة (المحولة مقفلة نهائياً لوجود فاتورة ناتجة)
  // ترميم العدّادات المتداخلة (jstore يرمم مفاتيح المستوى الأعلى فقط — المتداخلة يدوياً)
  _cmdSeq(d) {
    d.seq = d.seq || {};
    if (!Number.isInteger(d.seq.cmdorder) || d.seq.cmdorder < 1) d.seq.cmdorder = 1;
    if (!Number.isInteger(d.seq.cmdorder_num) || d.seq.cmdorder_num < 1) d.seq.cmdorder_num = 1;
    if (!Array.isArray(d.cmdorders)) d.cmdorders = [];
    return d;
  },
  _cmdLines(md, items) {
    if (!Array.isArray(items) || !items.length) err('سطور الطلبية مطلوبة (منتج واحد على الأقل)');
    const out = [];
    for (const ln of items) {
      const it = getProduct(md, ln.item_id);
      const qty = toNum(ln.qty, 'كمية ' + it.name);
      const price = toNum(ln.price, 'سعر ' + it.name);
      if (!(qty > 0)) err('كمية ' + it.name + ' أكبر من صفر');
      if (price < 0) err('السعر لا يكون سالباً');
      if (out.some(o => o.item_id === it.id)) err('المنتج مكرر في الطلبية: ' + it.name);
      out.push({ item_id: it.id, item_name: it.name, unit: it.unit, qty: r2(qty), price: r2(price), total: r2(qty * price) });
    }
    return out;
  },
  _cmdView(o) {
    return { ...o, total: r2((o.lines || []).reduce((s, l) => s + Number(l.total || 0), 0)) };
  },
  listCmdOrders() {
    const d = db.load();
    return { data: ((d.cmdorders || []).slice().sort((a, b) => (a.id < b.id ? 1 : -1))).map(o => this._cmdView(o)) };
  },
  getCmdOrder(id) {
    const d = db.load();
    const o = (d.cmdorders || []).find(x => x.id === Number(id));
    if (!o) err('الطلبية غير موجودة', 404);
    return { data: this._cmdView(o) };
  },
  addCmdOrder(b, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الطلبيات: المدير أو المحاسب فقط', 403);
    const md = mdata();
    const cust = getCustomer(md, b.customer_id);
    const lines = this._cmdLines(md, b.items);
    const d = this._cmdSeq(db.load());
    const date = validDate(b.date || now().slice(0, 10), 'التاريخ');
    try { System.get(); } catch {} // ترحيل صيغة ترقيم CMD أولاً
    const row = {
      id: d.seq.cmdorder++, num: System.formatNum('cmd', { year: date.slice(0, 4), n: d.seq.cmdorder_num++ }),
      customer_id: cust.id, customer_name: cust.name, date, lines,
      delivery_date: validDate(b.delivery_date, 'تاريخ التسليم'),
      destination: String(b.destination || '').trim().slice(0, 120),
      driver: String(b.driver || '').trim().slice(0, 120),
      note: String(b.note || '').trim().slice(0, 200),
      status: 'مسودة', invoice_id: null, invoice_num: '',
      created_by: ctx.user, created_at: now(), updated_at: now()
    };
    d.cmdorders.push(row);
    db.save(d);
    return { data: this._cmdView(row) };
  },
  updateCmdOrder(id, b, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الطلبيات: المدير أو المحاسب فقط', 403);
    const d = db.load();
    const o = (d.cmdorders || []).find(x => x.id === Number(id));
    if (!o) err('الطلبية غير موجودة', 404);
    if (o.status === 'محولة') err('الطلبية المحولة مقفلة — عدّل فاتورة البيع الناتجة (' + (o.invoice_num || '') + ')');
    const md = mdata();
    if (b.customer_id !== undefined) {
      const cust = getCustomer(md, b.customer_id);
      o.customer_id = cust.id; o.customer_name = cust.name;
    }
    if (b.date !== undefined) o.date = validDate(b.date, 'التاريخ');
    if (b.delivery_date !== undefined) o.delivery_date = validDate(b.delivery_date, 'تاريخ التسليم');
    if (b.items !== undefined) o.lines = this._cmdLines(md, b.items);
    if (b.destination !== undefined) o.destination = String(b.destination || '').trim().slice(0, 120);
    if (b.driver !== undefined) o.driver = String(b.driver || '').trim().slice(0, 120);
    if (b.note !== undefined) o.note = String(b.note || '').trim().slice(0, 200);
    o.updated_at = now();
    db.save(d);
    return { data: this._cmdView(o) };
  },
  deleteCmdOrder(id, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الطلبيات: المدير أو المحاسب فقط', 403);
    const d = db.load();
    const i = (d.cmdorders || []).findIndex(x => x.id === Number(id));
    if (i < 0) err('الطلبية غير موجودة', 404);
    if (d.cmdorders[i].status !== 'مسودة') err('الحذف للطلبيات المسودة فقط — الموثقة تُحوَّل لفاتورة');
    d.cmdorders.splice(i, 1);
    db.save(d);
    return { ok: true };
  },
  documentCmdOrder(id, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الطلبيات: المدير أو المحاسب فقط', 403);
    const d = db.load();
    const o = (d.cmdorders || []).find(x => x.id === Number(id));
    if (!o) err('الطلبية غير موجودة', 404);
    if (o.status !== 'مسودة') err('التوثيق من مسودة فقط');
    o.status = 'موثقة'; o.documented_by = ctx.user; o.documented_at = now(); o.updated_at = now();
    db.save(d);
    return { data: this._cmdView(o) };
  },
  undocumentCmdOrder(id, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الطلبيات: المدير أو المحاسب فقط', 403);
    const d = db.load();
    const o = (d.cmdorders || []).find(x => x.id === Number(id));
    if (!o) err('الطلبية غير موجودة', 404);
    if (o.status !== 'موثقة') err('إلغاء التوثيق من طلبية موثقة فقط');
    o.status = 'مسودة'; o.updated_at = now();
    db.save(d);
    return { data: this._cmdView(o) };
  },
  convertCmdOrder(id, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الطلبيات: المدير أو المحاسب فقط', 403);
    const d = db.load();
    const o = (d.cmdorders || []).find(x => x.id === Number(id));
    if (!o) err('الطلبية غير موجودة', 404);
    if (o.status !== 'موثقة') err('التحويل لفاتورة من طلبية موثقة فقط — وثّقها أولاً');
    // بوابة الرصيد: التحويل التزام بالتوريد — الرفوف الفارغة تُرفض هنا لا عند التأكيد
    // (المسودة المولدة بلا رصيد فخ: لا تُؤكَّد أبداً وتُربك الدورة)
    const av = {};
    try {
      for (const a of this.availability().data) av[Number(a.item_id)] = Number(a.remaining || 0);
    } catch {}
    const short = (o.lines || []).filter(l => (av[Number(l.item_id)] || 0) + 1e-9 < Number(l.qty || 0));
    if (short.length) err('التحويل مرفوض: رصيد غير كافٍ — ' + short.map(l => l.item_name + ' (المطلوب ' + l.qty + ' — المتاح ' + (av[Number(l.item_id)] || 0) + ')').join('، '));
    // فاتورة مسودة بالقيم نفسها عبر المسار الرسمي (تولّد وصلها المؤقت وفاتورتها تلقائياً)
    const inv = this.addInvoice({
      customer_id: o.customer_id, date: o.date, note: o.note,
      destination: o.destination, driver: o.driver, delivery_date: o.delivery_date,
      items: o.lines.map(l => ({ item_id: l.item_id, qty: l.qty, price: l.price }))
    }, ctx).data;
    // إعادة التحميل (addInvoice حفظت الفاتورة — الحفظ بلقطة قديمة كان سيمحوها)
    const d2 = db.load();
    const o2 = (d2.cmdorders || []).find(x => x.id === Number(id));
    o2.status = 'محولة'; o2.invoice_id = inv.id; o2.invoice_num = inv.num;
    o2.converted_by = ctx.user; o2.converted_at = now(); o2.updated_at = now();
    db.save(d2);
    return { data: { order: this._cmdView(o2), invoice: inv } };
  },

  // ---- الطلبات الخارجية (واجهة الزوار — بلا دخول، بلا أي أثر مخزني/مالي) ----
  // السعر من الخادم دائماً (سعر العميل تجاهلي) — الكتالوج: منتج تام برصيد + آخر سعر بيع
  _extSeq(d) {
    d.seq = d.seq || {};
    if (!Number.isInteger(d.seq.extorder) || d.seq.extorder < 1) d.seq.extorder = 1;
    if (!Number.isInteger(d.seq.extorder_num) || d.seq.extorder_num < 1) d.seq.extorder_num = 1;
    if (!Array.isArray(d.extorders)) d.extorders = [];
    return d;
  },
  _lastSalePrice(item_id) {
    try {
      const d = db.load();
      const invs = (d.invoices || []).filter(o => o.status === 'مؤكدة');
      for (let i = invs.length - 1; i >= 0; i--) {
        const l = (invs[i].lines || []).find(x => Number(x.item_id) === Number(item_id));
        if (l) return r2(Number(l.price || 0));
      }
    } catch {}
    return 0;
  },
  // حزمة صفحة الترحيب العمومية: المصنع + إعدادات الواجهة + الكتالوج بعد تجاوزات المدير
  publicLanding() {
    const sys = System.get();
    const L = (sys && sys.landing) || {};
    const cat = this._applyPriceOverrides(this.publicCatalog().data);
    const products = cat.filter(p => {
      const o = ((L.products && typeof L.products === 'object') ? L.products : {})[String(p.item_id)];
      return !o || o.show !== false;
    });
    return { data: { factory: (sys.factory || {}), landing: L, products } };
  },
  // تجاوزات أسعار المدير (النظام ← صفحة الترحيب): تُطبق على الكتالوج العلني وتسعير الطلبات
  _priceOverrides() {
    try {
      const L = (System.get() || {}).landing || {};
      return (L.products && typeof L.products === 'object') ? L.products : {};
    } catch { return {}; }
  },
  _applyPriceOverrides(list) {
    const ov = this._priceOverrides();
    return (list || []).map(p => {
      const o = ov[String(p.item_id)] || {};
      return Object.assign({}, p, {
        price: (o.price !== null && o.price !== undefined) ? o.price : p.price,
        old: (o.old !== null && o.old !== undefined) ? o.old : null
      });
    });
  },
  publicCatalog() {    const md = mdata();
    const finIds = new Set((md.items || []).filter(it => {
      const c = (md.categories || []).find(x => x.id === Number(it.category_id));
      return c && c.main === 'منتج نهائي' && it.status !== 'متوقفة';
    }).map(it => it.id));
    let avail = {};
    try {
      for (const a of this.availability().data) avail[Number(a.item_id)] = a;
    } catch {}
    const out = [];
    for (const id of finIds) {
      const a = avail[id];
      if (!a || !(Number(a.remaining || 0) > 0)) continue;
      const it = (md.items || []).find(x => x.id === id) || {};
      out.push({
        item_id: id, item_name: a.item_name, unit: a.unit || it.unit || 'قنطار',
        remaining: Number(a.remaining || 0), price: this._lastSalePrice(id)
      });
    }
    return { data: out.sort((x, y) => String(x.item_name) < String(y.item_name) ? -1 : 1) };
  },
  _checkGuestPhone(ph) {
    const s = String(ph || '').replace(/[\s-]/g, '');
    if (!/^0(5|6|7)\d{8}$/.test(s)) err('رقم الهاتف: 10 أرقام جزائرية تبدأ بـ 05/06/07');
    return s;
  },
  publicOrder(b, ip) {
    const md = mdata();
    const name = String((b && b.name) || '').trim().slice(0, 60);
    if (name.length < 3) err('الاسم الكامل مطلوب (3 أحرف على الأقل)');
    const phone = this._checkGuestPhone(b && b.phone);
    const address = String((b && b.address) || '').trim().slice(0, 120);
    if (address.length < 3) err('العنوان/البلدية مطلوب');
    if (!Array.isArray(b.items) || !b.items.length) err('اختر منتجاً واحداً على الأقل');
    if (b.items.length > 10) err('عشرة منتجات كحد أقصى في الطلب الواحد');
    const cat = {};
    try {
      for (const p of this._applyPriceOverrides(this.publicCatalog().data)) cat[Number(p.item_id)] = p;
    } catch {}
    const seen = {};
    const lines = [];
    for (const ln of b.items) {
      const p = cat[Number(ln && ln.item_id)];
      if (!p) err('منتج غير متوفر حالياً');
      if (seen[p.item_id]) err('المنتج مكرر: ' + p.item_name);
      seen[p.item_id] = 1;
      const qty = toNum(ln.qty, 'كمية ' + p.item_name);
      if (!(qty > 0)) err('كمية ' + p.item_name + ' أكبر من صفر');
      if (qty > 500) err('كمية ' + p.item_name + ' تتجاوز 500 — للكميات الكبيرة اتصل بالمصنع');
      if (qty > Number(p.remaining || 0) + 1e-9) err('الكمية المطلوبة من ' + p.item_name + ' تفوق المتاح (' + p.remaining + ')');
      lines.push({ item_id: p.item_id, item_name: p.item_name, unit: p.unit, qty: r2(qty), price: r2(Number(p.price || 0)), total: r2(qty * Number(p.price || 0)) });
    }
    const d = this._extSeq(db.load());
    // منع الإغراق: طلب واحد قيد الانتظار لنفس الرقم (طلب جديد بعد معالجة القديم)
    const pending = (d.extorders || []).some(x => x.phone === phone && (x.status === 'جديدة' || x.status === 'مؤجلة'));
    if (pending) err('لديك طلب قيد المعالجة بهذا الرقم — انتظر اتصالنا قبل طلب جديد');
    const date = now().slice(0, 10);
    const row = {
      id: d.seq.extorder++, num: 'EXT-' + date.slice(0, 4) + '-' + String(d.seq.extorder_num++).padStart(3, '0'),
      name, phone, address, note: String((b && b.note) || '').trim().slice(0, 200),
      date, lines, total: r2(lines.reduce((s, l) => s + l.total, 0)),
      status: 'جديدة', remind_date: '', cancel_reason: '', cmd_num: '',
      ip: String(ip || '').slice(0, 45), created_at: now(), updated_at: now()
    };
    d.extorders.push(row);
    db.save(d);
    return { data: { num: row.num, total: row.total, lines: row.lines.length } };
  },
  trackOrder(phone, num) {
    const ph = String(phone || '').trim();
    const nm = String(num || '').trim().toUpperCase();
    if (!ph || !nm) err('أدخل رقم الهاتف ورقم الطلب');
    const d = db.load();
    const o = (d.extorders || []).find(x => x.phone === ph && String(x.num || '').toUpperCase() === nm);
    if (!o) err('لا طلب بهذه البيانات — تحقق من الرقمين', 404);
    return { data: { num: o.num, date: o.date, status: o.status, total: o.total, lines: o.lines, remind_date: o.remind_date || '', cancel_reason: o.cancel_reason || '' } };
  },
  listExtOrders(ctx) {
    if (!Auth.can(ctx.role, 'sales', 'view')) err('غير مصرح', 403);
    const d = db.load();
    return { data: (d.extorders || []).slice().sort((a, b) => (a.id < b.id ? 1 : -1)) };
  },
  decideExtOrder(id, b, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الطلبيات: المدير أو المحاسب فقط', 403);
    const dec = String((b && b.decision) || '');
    if (dec !== 'مؤكدة' && dec !== 'مؤجلة' && dec !== 'ملغاة' && dec !== 'مؤرشفة') err('القرار: مؤكدة / مؤجلة / ملغاة / مؤرشفة');
    if (dec === 'مؤكدة') {
      // التحويل لطلبية داخلية: زبون موجود بنفس الهاتف وإلا إنشاء تلقائي، ثم طلبية موثقة مباشرة
      const Master = require('./master');
      const md = mdata();
      const d0 = db.load();
      const src = (d0.extorders || []).find(x => x.id === Number(id));
      if (!src) err('الطلب غير موجود', 404);
      if (src.status !== 'جديدة' && src.status !== 'مؤجلة') err('هذا الطلب عولج مسبقاً (' + src.status + ')');
      let cust = (md.customers || []).find(c => String(c.phone || '').replace(/[\s-]/g, '') === src.phone && c.active !== false);
      if (!cust) {
        cust = Master.addCustomer({ name: src.name, phone: src.phone, address: src.address, kind: 'تجزئة', price_type: 'تجزئة' }, ctx).data;
      }
      const cmd = this.addCmdOrder({
        customer_id: cust.id, date: now().slice(0, 10),
        delivery_date: now().slice(0, 10), destination: src.address, driver: '',
        note: 'طلب خارجي ' + src.num + ' — ' + src.name + ' (' + src.phone + ')',
        items: src.lines.map(l => ({ item_id: l.item_id, qty: l.qty, price: l.price }))
      }, ctx).data;
      this.documentCmdOrder(cmd.id, ctx);
      // إعادة التحميل (addCmdOrder/document حفظا — الحفظ بلقطة قديمة كان سيمحوهما)
      const d2 = db.load();
      const o2 = (d2.extorders || []).find(x => x.id === Number(id));
      o2.status = 'مؤكدة'; o2.cmd_num = cmd.num; o2.cancel_reason = '';
      o2.decided_by = ctx.user; o2.updated_at = now();
      db.save(d2);
      return { data: { id: o2.id, num: o2.num, status: o2.status, cmd_num: o2.cmd_num || '' } };
    }
    const d = db.load();
    const o = (d.extorders || []).find(x => x.id === Number(id));
    if (!o) err('الطلب غير موجود', 404);
    if (dec === 'مؤرشفة') {
      // الأرشفة للمعالَجة فقط (مؤكدة/ملغاة/مؤجلة) — الجديدة تُعالَج أولاً
      if (o.status === 'جديدة') err('عالج الطلب أولاً (تأكيد/تأجيل/إلغاء) قبل أرشفته');
      if (o.status === 'مؤرشفة') err('مؤرشف مسبقاً');
      o.status = 'مؤرشفة';
      o.decided_by = ctx.user; o.updated_at = now();
      db.save(d);
      return { data: { id: o.id, num: o.num, status: o.status, cmd_num: o.cmd_num || '' } };
    }
    if (o.status !== 'جديدة' && o.status !== 'مؤجلة') err('هذا الطلب عولج مسبقاً (' + o.status + ')');
    if (dec === 'ملغاة') {
      o.status = 'ملغاة';
      o.cancel_reason = String((b && b.reason) || '').trim().slice(0, 120) || 'بلا سبب مسجل';
    } else {
      o.status = 'مؤجلة';
      o.remind_date = (b && b.remind_date) ? validDate(b.remind_date, 'تاريخ التذكير') : '';
      o.cancel_reason = '';
    }
    o.decided_by = ctx.user; o.updated_at = now();
    db.save(d);
    return { data: { id: o.id, num: o.num, status: o.status, cmd_num: o.cmd_num || '' } };
  },
  // أرشفة تلقائية: كل معالَج (مؤكدة/ملغاة/مؤجلة) أقدم من 30 يوماً → مؤرشفة
  archiveOldExtOrders(ctx) {
    if (!Auth.can(ctx.role, 'sales', 'invoice')) err('الطلبيات: المدير أو المحاسب فقط', 403);
    const d = db.load();
    const cut = Date.now() - 30 * 86400000;
    let n = 0;
    for (const o of (d.extorders || [])) {
      if ((o.status === 'مؤكدة' || o.status === 'ملغاة' || o.status === 'مؤجلة') && Date.parse(o.updated_at || o.created_at || '') < cut) {
        o.status = 'مؤرشفة'; o.updated_at = now(); n++;
      }
    }
    if (n) db.save(d);
    return { data: { archived: n } };
  },

  // ---- التحصيل ----
  listReceipts(invoice_id, ctx) {
    const d = db.load();
    let rows = (invoice_id ? d.receipts.filter(x => x.invoice_id === Number(invoice_id)) : d.receipts).slice().sort((a, b) => (a.id < b.id ? 1 : -1));
    rows = this._scopeRows(rows, ctx || {});
    return { data: rows };
  },
  addReceipt(b, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'receipt')) err('التحصيل: المدير أو المحاسب فقط', 403);
    const d = db.load();
    const o = d.invoices.find(x => x.id === Number(b.invoice_id));
    if (!o) err('الفاتورة غير موجودة', 404);
    if (o.status !== 'مؤكدة') err('التحصيل للفاتورة المؤكدة فقط');
    this._mine(o, ctx, 'الفاتورة');
    // عدم تكرار: مفتاح العميل يمنع سنداً مزدوجاً (نقر مزدوج/إعادة إرسال بعد نجاح ضائع الرد)
    const ckey = String((b && b.client_key) || '').trim().slice(0, 40);
    if (ckey) {
      const dup = d.receipts.find(x => Number(x.invoice_id) === Number(o.id) && String(x.client_key || '') === ckey);
      if (dup) return { data: dup, deduped: true };
    }
    if (!METHODS.includes(b.method)) err('الطريقة: ' + METHODS.join(' / '));
    const amount = toNum(b.amount, 'المبلغ');
    // الحساب ملزم لكل قبض فعلي: النقد في صندوق، والتحويل/الشيك في بنك
    // المؤخر وعد لا قبض: صفر إجباري وبلا حساب، لا يُنقص الدين ولا يدخل الدفتر
    let account = '';
    if (b.method === 'مؤخر') {
      if (amount !== 0) err('المؤخر وعد لاحق — المبلغ صفر إجباري');
    } else {
      if (!(amount > 0)) err('المبلغ أكبر من صفر');
      account = checkReceiptAccount(b.method, b.account);
    }
    const row = {
      id: d.seq.receipt++, num: System.formatNum('receipt', { year: validDate(b.date || now().slice(0, 10), 'التاريخ').slice(0, 4), n: d.seq.receipt_num++ }),
      invoice_id: o.id, invoice_num: o.num, customer_id: o.customer_id, customer_name: o.customer_name,
      date: validDate(b.date || now().slice(0, 10), 'التاريخ'),
      method: b.method, amount: r2(amount), account, note: String(b.note || '').trim().slice(0, 200),
      client_key: ckey || undefined,
      created_by: ctx.user, created_at: now()
    };
    d.receipts.push(row);
    db.save(d);
    return { data: row };
  },
  updateReceipt(id, b, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'receipt')) err('التحصيل: المدير أو المحاسب فقط', 403);
    const d = db.load();
    const r = d.receipts.find(x => x.id === Number(id));
    if (!r) err('غير موجود', 404);
    this._mine(r, ctx, 'السند');
    if (b.date !== undefined) r.date = validDate(b.date, 'التاريخ');
    if (b.method !== undefined) {
      if (!METHODS.includes(b.method)) err('الطريقة: ' + METHODS.join(' / '));
      r.method = b.method;
    }
    if (b.amount !== undefined) {
      r.amount = r2(toNum(b.amount, 'المبلغ'));
    }
    if (b.account !== undefined) r.account = String(b.account || '').trim();
    if (r.method === 'مؤخر') {
      if (r.amount !== 0) err('المؤخر وعد لاحق — المبلغ صفر إجباري');
      r.account = '';
    } else {
      if (!(r.amount > 0)) err('المبلغ أكبر من صفر');
      r.account = checkReceiptAccount(r.method, r.account);
    }
    if (b.note !== undefined) r.note = String(b.note || '').trim().slice(0, 200);
    db.save(d);
    return { data: r };
  },
  deleteReceipt(id, ctx) {
    if (ctx.role !== 'admin') err('حذف السند للمدير فقط', 403);
    const d = db.load();
    const i = d.receipts.findIndex(x => x.id === Number(id));
    if (i < 0) err('غير موجود', 404);
    this._mine(d.receipts[i], ctx, 'السند');
    d.receipts.splice(i, 1);
    db.save(d);
    return { ok: true };
  },

  // ---- تحصيل مستقل من زبون: بلا فاتورة (تسديد دين افتتاحي/قديم، أو عربون مقدم) ----
  // ينقص الدين العام للزبون تلقائياً (الكشوفات والملخص والديون على مستوى الزبون) — الزائد = دائن علينا
  addStandaloneReceipt(b, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'receipt')) err('التحصيل: المدير أو المحاسب فقط', 403);
    const md = mdata();
    const cust = getCustomer(md, b.customer_id);
    if (cust.active === false) err('الزبون موقف — فعّله من البيانات الأساسية أولاً');
    const payType = b.pay_type === 'عربون' ? 'عربون' : 'دفع زبون';
    if (b.method !== 'نقدي' && b.method !== 'شيك') err('طريقة الدفع: نقدي / شيك');
    const amount = toNum(b.amount, 'المبلغ');
    if (!(amount > 0)) err('المبلغ أكبر من صفر');
    const date = validDate(b.date || now().slice(0, 10), 'التاريخ');
    const account = checkReceiptAccount(b.method, b.account);
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
    if (!Number.isInteger(d.seq.receipt_num) || d.seq.receipt_num < 1) d.seq.receipt_num = 1;
    const row = {
      id: d.seq.receipt++, num: System.formatNum('receipt', { year: new Date(date).getFullYear(), n: d.seq.receipt_num++ }),
      invoice_id: null, invoice_num: '', customer_id: cust.id, customer_name: cust.name,
      pay_type: payType, date, method: b.method, amount: r2(amount), account, check,
      note: String(b.note || '').trim().slice(0, 200),
      created_by: ctx.user, created_at: now()
    };
    d.receipts.push(row);
    db.save(d);
    return { data: row };
  },

  // ---- المرتجع: للمخزون مباشرة + تخفيض الدين بسعر البيع الأصلي ----
  listReturns(ctx) {
    const d = db.load();
    let rows = d.returns.slice().sort((a, b) => (a.id < b.id ? 1 : -1));
    if ((ctx || {}).role === 'salesman') {
      const own = new Set(d.invoices.filter(o => o.created_by === ctx.user).map(o => o.id));
      rows = rows.filter(x => own.has(Number(x.invoice_id)));
    }
    return { data: rows };
  },
  addReturn(b, ctx) {
    if (!Auth.can(ctx.role, 'sales', 'return')) err('المرتجع: المدير أو أمين المخزن فقط', 403);
    const md = mdata();
    const d = db.load();
    const o = d.invoices.find(x => x.id === Number(b.invoice_id));
    if (!o) err('الفاتورة غير موجودة', 404);
    if (o.status !== 'مؤكدة') err('المرتجع للفاتورة المؤكدة فقط');
    this._mine(o, ctx, 'الفاتورة');
    if (!RETURN_REASONS.includes(b.reason)) err('السبب: ' + RETURN_REASONS.join(' / '));
    const wh = md.warehouses.find(w => w.id === Number(b.warehouse_id)) || md.warehouses.find(w => w.id === o.warehouse_id) || md.warehouses[0];
    if (!wh) err('لا يوجد مخزن');
    if (!Array.isArray(b.lines) || !b.lines.length) err('سطور المرتجع مطلوبة');
    // المتاح إرجاعه = المباع − المرجع سابقاً
    const prevRet = {};
    for (const rt of d.returns.filter(x => x.invoice_id === o.id)) {
      for (const l of rt.lines) prevRet[l.item_id] = r2((prevRet[l.item_id] || 0) + Number(l.qty || 0));
    }
    const lines = [];
    for (const ln of b.lines) {
      const ol = o.lines.find(l => l.item_id === Number(ln.item_id));
      if (!ol) err('منتج خارج الفاتورة الأصلية');
      const q = toNum(ln.qty, 'مرتجع ' + ol.item_name);
      if (!(q > 0)) err('كمية المرتجع أكبر من صفر');
      const max = r2(ol.qty - (prevRet[ol.item_id] || 0));
      if (q > max + 1e-9) err('مرتجع ' + ol.item_name + ' يتجاوز المتبقي (' + max + ')');
      lines.push({ item_id: ol.item_id, item_name: ol.item_name, unit: ol.unit, qty: r2(q), price: ol.price });
    }
    const date = validDate(b.date || now().slice(0, 10), 'التاريخ');
    const row = {
      id: d.seq.ret++, num: System.formatNum('ret', { year: date.slice(0, 4), n: d.seq.ret_num++ }),
      invoice_id: o.id, invoice_num: o.num, customer_id: o.customer_id, customer_name: o.customer_name,
      date, warehouse_id: wh.id, warehouse_name: wh.name, lines,
      reason: b.reason, note: String(b.note || '').trim(),
      created_by: ctx.user, created_at: now()
    };
    d.returns.push(row);
    // دخول مباشر للمخزون بتكلفة البيع المسجلة
    for (const l of lines) {
      const ol = o.lines.find(x => x.item_id === l.item_id);
      Stock.receiveLot({
        item_id: l.item_id, item_name: l.item_name, unit: l.unit, qty: l.qty,
        cost: Number(ol.cost_snapshot || 0), warehouse_id: wh.id, warehouse_name: wh.name,
        expiry: '', qc: 'مقبولة', order_num: row.num, supplier_name: 'مرتجع ' + o.customer_name,
        date, user: ctx.user
      });
    }
    // المرتجع مغلّف: الأكياس تعود مع المنتج (تناظر خصم البيع)
    try {
      const Issue = require('./inventory-check');
      const bagIt = Issue.bagsItem ? Issue.bagsItem() : null;
      const perQ = Issue.BAGS_PER_Q || 2;
      if (bagIt) {
        let back = 0;
        for (const l of lines) back += Math.ceil(Number(l.qty || 0) * perQ - 1e-9);
        if (back > 0) {
          const md2 = mdata();
          const bag = (md2.items || []).find(x => x.id === bagIt.id) || {};
          // الأكياس مادة خام: تعود لأول مخزن خام (لا لمخزن التام المختار للمرتجع)
          const bagWh = (md2.warehouses || []).find(w => w.type === 'مواد أولية') || wh;
          Stock.receiveLot({
            item_id: bagIt.id, item_name: bagIt.name, unit: bagIt.unit, qty: back,
            cost: Number(bag.last_price || 0), warehouse_id: bagWh.id, warehouse_name: bagWh.name,
            expiry: '', qc: 'مقبولة', order_num: row.num, supplier_name: 'مرتجع ' + o.customer_name,
            date, user: ctx.user
          });
          row.bags_back = back;
        }
      }
    } catch (e) {}
    db.save(d);
    // تحديث الوصل النهائي بالمرتجع (إثبات التسليم يوثّق الخلل — نسخة الزبون والأرشيف)
    try { require('./billing').onReturn(row, ctx); } catch {}
    return { data: row };
  },

  // ---- نشاط الزبون: بطاقة + سجل مشتريات ومدفوعات ومرتجعات بفترة + ديون سابقة/حالية ----
  // الدفتر: الفاتورة المؤكدة ترفع الدين، والتحصيل والمرتجع (بسعر البيع الأصلي) يخفضانه — المسودة بلا أثر
  customerActivity(customer_id, from, to) {
    const d = db.load();
    const md = mdata();
    const cust = md.customers.find(x => x.id === Number(customer_id));
    if (!cust) err('الزبون غير موجود', 404);
    if (from) validDate(from, 'من');
    if (to) validDate(to, 'إلى');
    if (from && to && from > to) err('من أكبر من إلى', 400);
    const inRange = dt => (!from || String(dt || '') >= from) && (!to || String(dt || '') <= to);
    const isCash = m => METHODS.includes(m) && m !== 'مؤخر';
    const retValOf = rt => r2((rt.lines || []).reduce((s, l) => s + Number(l.qty || 0) * Number(l.price || 0), 0));
    const opening = toNum(cust.opening_debt, 'الدين الافتتاحي');
    const conf = o => o.status === 'مؤكدة';
    // الديون السابقة: افتتاحي + فواتير قبل الفترة − تحصيل − مرتجعات قبل الفترة
    let prevInv = 0, prevPaid = 0, prevRet = 0;
    for (const o of d.invoices || []) {
      if (Number(o.customer_id) !== cust.id || !conf(o)) continue;
      if (from && String(o.date || '') < from) prevInv = r2(prevInv + Number(o.total || 0));
    }
    for (const x of d.receipts || []) {
      if (Number(x.customer_id) !== cust.id) continue;
      if (from && String(x.date || '') < from && isCash(x.method)) prevPaid = r2(prevPaid + Number(x.amount || 0));
    }
    for (const rt of d.returns || []) {
      if (Number(rt.customer_id) !== cust.id) continue;
      if (from && String(rt.date || '') < from) prevRet = r2(prevRet + retValOf(rt));
    }
    const prev = r2(opening + prevInv - prevPaid - prevRet);
    // سجل الفترة (أو كل النشاط): مشتريات + تحصيل + مرتجعات مرتبة زمنياً مع رصيد متحرك
    const lines = [];
    for (const o of d.invoices || []) {
      if (Number(o.customer_id) !== cust.id || !conf(o) || !inRange(o.date)) continue;
      const goods = (o.lines || []).map(l => l.item_name + ' ' + Number(l.qty || 0) + ' ' + (l.unit || '')).join(' + ');
      lines.push({ date: o.date, kind: 'مشتريات', ref: o.num || '', detail: goods, total: r2(Number(o.total || 0)), effect: r2(Number(o.total || 0)), _id: 'i' + o.id });
    }
    for (const x of d.receipts || []) {
      if (Number(x.customer_id) !== cust.id || !inRange(x.date)) continue;
      const cash = isCash(x.method) ? r2(Number(x.amount || 0)) : 0;
      lines.push({ date: x.date, kind: x.method === 'مؤخر' ? 'وعد مؤخر' : 'تحصيل', ref: x.invoice_num || x.num || '', detail: x.method + (x.account ? ' — ' + x.account : '') + (x.note ? ' — ' + x.note : ''), total: r2(Number(x.amount || 0)), effect: -cash, _id: 'r' + x.id });
    }
    for (const rt of d.returns || []) {
      if (Number(rt.customer_id) !== cust.id || !inRange(rt.date)) continue;
      const rv = retValOf(rt);
      const goods = (rt.lines || []).map(l => l.item_name + ' ' + Number(l.qty || 0)).join(' + ');
      lines.push({ date: rt.date, kind: 'مرتجع', ref: rt.num || '', detail: goods + (rt.reason ? ' — ' + rt.reason : ''), total: rv, effect: -rv, _id: 't' + rt.id });
    }
    lines.sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : (a._id < b._id ? -1 : 1)));
    let bal = prev, invTot = 0, paidTot = 0, retTot = 0;
    for (const l of lines) {
      if (l.kind === 'مشتريات') invTot = r2(invTot + l.effect);
      else if (l.kind === 'مرتجع') retTot = r2(retTot - l.effect);
      else if (l.effect < 0) paidTot = r2(paidTot - l.effect);
      bal = r2(bal + l.effect);
      l.balance = bal;
    }
    // السلعة المشتراة: تجميع الكميات والقيم داخل الفترة (المؤكدة فقط)
    const byItem = {};
    for (const o of d.invoices || []) {
      if (Number(o.customer_id) !== cust.id || !conf(o) || !inRange(o.date)) continue;
      for (const l of o.lines || []) {
        const k = l.item_name || ('#' + l.item_id);
        byItem[k] = byItem[k] || { name: k, unit: l.unit || '', qty: 0, total: 0 };
        byItem[k].qty = r2(byItem[k].qty + Number(l.qty || 0));
        byItem[k].total = r2(byItem[k].total + Number(l.total || 0));
      }
    }
    return {
      data: {
        customer: {
          id: cust.id, code: cust.code || '', name: cust.name, phone: cust.phone || '', address: cust.address || '',
          kind: cust.kind || 'تجزئة', price_type: cust.price_type || 'تجزئة',
          rc: cust.rc || '', mf: cust.mf || '', art_imp: cust.art_imp || '', nis: cust.nis || '',
          breeder_card: cust.breeder_card || ''
        },
        from: from || '', to: to || '',
        prev: { opening, invoices: prevInv, paid: prevPaid, returns: prevRet, total: prev },
        lines, goods: Object.values(byItem),
        totals: { invoices: invTot, paid: paidTot, returns: retTot, current: bal },
        generated_at: new Date().toISOString().slice(0, 16).replace('T', ' ')
      }
    };
  },
  // ---- ملخص كل الزبائن: ديون سابقة/حالية + تحصيلات + كميات + فواتير + افتتاحي + مرتجعات ----
  // نفس دفتر customerActivity مطبقاً على كل زبون (الفترة اختيارية) — المؤكدة فقط
  // ---- بطاقة الزبون الذكية (المرحلة 1): آخر طلبية + آخر فاتورة + المبيعات + المفضل + المرتجعات + الدين + الربح ----
  // قراءة فقط من السجلات القائمة — بلا حقول جديدة وبلا أي أثر
  customerProfile(customer_id) {
    const d = db.load();
    const md = mdata();
    const cust = md.customers.find(x => x.id === Number(customer_id));
    if (!cust) err('الزبون غير موجود', 404);
    const conf = o => o.status === 'مؤكدة';
    const retValOf = rt => r2((rt.lines || []).reduce((s, l) => s + Number(l.qty || 0) * Number(l.price || 0), 0));
    // آخر طلبية (أي حالة) وآخر فاتورة مؤكدة
    const myCmds = (d.cmdorders || []).filter(x => Number(x.customer_id) === cust.id)
      .sort((a, b) => (String(a.date || '') < String(b.date || '') ? -1 : 1));
    const lastCmd = myCmds.length ? myCmds[myCmds.length - 1] : null;
    const myInvs = (d.invoices || []).filter(o => Number(o.customer_id) === cust.id && conf(o))
      .sort((a, b) => (String(a.date || '') < String(b.date || '') ? -1 : 1));
    const lastInv = myInvs.length ? myInvs[myInvs.length - 1] : null;
    // المبيعات + المنتج المفضل (الأعلى قيمة) + الربح من لقطات التكلفة
    let invCount = myInvs.length, invTotal = 0, profit = 0;
    const pm = {};
    for (const o of myInvs) {
      invTotal = r2(invTotal + Number(o.total || 0));
      for (const l of o.lines || []) {
        profit = r2(profit + Number(l.margin || 0));
        const rev = r2(Number(l.qty || 0) * Number(l.price || 0));
        pm[l.item_id] = pm[l.item_id] || { item_id: l.item_id, name: l.item_name, unit: l.unit || '', qty: 0, revenue: 0 };
        pm[l.item_id].qty = r2(pm[l.item_id].qty + Number(l.qty || 0));
        pm[l.item_id].revenue = r2(pm[l.item_id].revenue + rev);
      }
    }
    const fav = Object.values(pm).sort((a, b) => b.revenue - a.revenue)[0] || null;
    // المرتجعات (عدد/قيمة بسعر البيع) تُخصم من الربح
    const myRets = (d.returns || []).filter(x => Number(x.customer_id) === cust.id);
    const retVal = r2(myRets.reduce((s, rt) => s + retValOf(rt), 0));
    profit = r2(profit - retVal);
    // الدين الحي: افتتاحي + مفوتر مؤكد − محصل نقداً − مرتجعات
    const isCash = m => METHODS.includes(m) && m !== 'مؤخر';
    const paid = r2((d.receipts || [])
      .filter(x => Number(x.customer_id) === cust.id && isCash(x.method))
      .reduce((s, x) => s + Number(x.amount || 0), 0));
    const debt = r2(toNum(cust.opening_debt, 'الدين الافتتاحي') + invTotal - paid - retVal);
    // الخمول (المرحلة 2): آخر نشاط (مؤكدة أو طلبية) + مهلة البطاقة + الحالة
    let lastAct = '';
    for (const o of myInvs) { const ds = String(o.date || ''); if (ds && (!lastAct || ds > lastAct)) lastAct = ds; }
    for (const o of (d.cmdorders || [])) {
      if (Number(o.customer_id) !== cust.id) continue;
      const ds = String(o.date || '');
      if (ds && (!lastAct || ds > lastAct)) lastAct = ds;
    }
    let idleDef = 7;
    try { idleDef = require('./system').tracking().defaultIdleDays; } catch {}
    const idleLim = Number(cust.idle_days) > 0 ? Number(cust.idle_days) : idleDef;
    let idleDays = null, idleStatus = 'new';
    if (lastAct) {
      idleDays = Math.round((Date.parse(now().slice(0, 10)) - Date.parse(lastAct)) / 86400000);
      idleStatus = idleDays > idleLim * 2 ? 'danger' : idleDays > idleLim ? 'warning' : 'active';
    }
    return {
      data: {
        customer: { id: cust.id, code: cust.code || '', name: cust.name, phone: cust.phone || '', kind: cust.kind || '', active: cust.active !== false },
        lastCmd: lastCmd ? { num: lastCmd.num, status: lastCmd.status, date: lastCmd.date || '' } : null,
        lastInvoice: lastInv ? { num: lastInv.num, date: lastInv.date || '', total: r2(Number(lastInv.total || 0)) } : null,
        sales: { count: invCount, total: invTotal },
        favProduct: fav,
        returns: { count: myRets.length, value: retVal },
        debt, profit,
        inactivity: { days: idleDays, limit: idleLim, status: idleStatus, last: lastAct },
        generated_at: new Date().toISOString().slice(0, 16).replace('T', ' ')
      }
    };
  },
  customersSummary(from, to) {
    const d = db.load();
    const md = mdata();
    if (from) validDate(from, 'من');
    if (to) validDate(to, 'إلى');
    if (from && to && from > to) err('من أكبر من إلى', 400);
    const isCash = m => METHODS.includes(m) && m !== 'مؤخر';
    const retValOf = rt => r2((rt.lines || []).reduce((s, l) => s + Number(l.qty || 0) * Number(l.price || 0), 0));
    const conf = o => o.status === 'مؤكدة';
    // آخر نشاط لكل زبون (مؤكدة أو طلبية — كل الفترات) لحالة الخمول في الملخص
    const lastActMap = {};
    for (const o of d.invoices || []) {
      if (!conf(o)) continue;
      const cid = Number(o.customer_id), ds = String(o.date || '');
      if (ds && (!lastActMap[cid] || ds > lastActMap[cid])) lastActMap[cid] = ds;
    }
    for (const o of (d.cmdorders || [])) {
      const cid = Number(o.customer_id), ds = String(o.date || '');
      if (ds && (!lastActMap[cid] || ds > lastActMap[cid])) lastActMap[cid] = ds;
    }
    const todayD = now().slice(0, 10);
    const rows = [];
    for (const cust of md.customers || []) {
      if (cust.active === false) continue;
      const opening = toNum(cust.opening_debt, 'الدين الافتتاحي');
      let prevInv = 0, prevPaid = 0, prevRet = 0, inInv = 0, inPaid = 0, inRet = 0, qty = 0, invs = 0;
      const unitCount = {};
      let lastPayDate = '', lastPayAmt = 0;
      for (const o of d.invoices || []) {
        if (Number(o.customer_id) !== cust.id || !conf(o)) continue;
        const dt = String(o.date || '');
        if (from && dt < from) { prevInv = r2(prevInv + Number(o.total || 0)); continue; }
        if (to && dt > to) continue;
        inInv = r2(inInv + Number(o.total || 0));
        invs++;
        for (const l of o.lines || []) {
          qty = r2(qty + Number(l.qty || 0));
          const u = String(l.unit || '').trim();
          if (u) unitCount[u] = (unitCount[u] || 0) + 1;
        }
      }
      for (const x of d.receipts || []) {
        if (Number(x.customer_id) !== cust.id || !isCash(x.method)) continue;
        const amt = r2(Number(x.amount || 0));
        const dt = String(x.date || '');
        if (from && dt < from) { prevPaid = r2(prevPaid + amt); continue; }
        if (to && dt > to) continue;
        inPaid = r2(inPaid + amt);
        if (!lastPayDate || dt >= lastPayDate) { lastPayDate = dt; lastPayAmt = amt; }
      }
      for (const rt of d.returns || []) {
        if (Number(rt.customer_id) !== cust.id) continue;
        const rv = retValOf(rt);
        const dt = String(rt.date || '');
        if (from && dt < from) { prevRet = r2(prevRet + rv); continue; }
        if (to && dt > to) continue;
        inRet = r2(inRet + rv);
      }
      const prev = r2(opening + prevInv - prevPaid - prevRet);
      // الوحدة السائدة للكمية (الأكثر تكراراً في سطور الفترة — وإلا فارغ)
      let qty_unit = '';
      try {
        const entries = Object.entries(unitCount).sort((a, b) => b[1] - a[1]);
        if (entries.length && (entries.length === 1 || entries[0][1] > entries[1][1])) qty_unit = entries[0][0];
      } catch {}
      const idleLast = lastActMap[Number(cust.id)] || '';
      let idleDef = 7;
      try { idleDef = require('./system').tracking().defaultIdleDays; } catch {}
      const idleLim = Number(cust.idle_days) > 0 ? Number(cust.idle_days) : idleDef;
      let idleDays = null, idleStatus = 'new';
      if (idleLast) {
        idleDays = Math.round((Date.parse(todayD) - Date.parse(idleLast)) / 86400000);
        idleStatus = idleDays > idleLim * 2 ? 'danger' : idleDays > idleLim ? 'warning' : 'active';
      }
      rows.push({
        customer_id: cust.id, code: cust.code || '', name: cust.name, phone: cust.phone || '',
        opening, prev, paid: inPaid, current: r2(prev + inInv - inPaid - inRet),
        total_qty: qty, qty_unit, inv_count: invs, returns: inRet,
        last_pay_date: lastPayDate, last_pay_amount: lastPayAmt,
        idle: { days: idleDays, limit: idleLim, status: idleStatus, last: idleLast }
      });
    }
    rows.sort((a, b) => b.current - a.current);
    const tot = rows.reduce((s, r) => ({ prev: r2(s.prev + r.prev), paid: r2(s.paid + r.paid), current: r2(s.current + r.current), qty: r2(s.qty + r.total_qty), invs: s.invs + r.inv_count, ret: r2(s.ret + r.returns) }), { prev: 0, paid: 0, current: 0, qty: 0, invs: 0, ret: 0 });
    return { data: { from: from || '', to: to || '', rows, totals: tot, generated_at: new Date().toISOString().slice(0, 16).replace('T', ' ') } };
  },

  // 👥 ذكاء العملاء والمنتجات: تجميع واحد لنافذة Dashboard — قراءة فقط، طلب واحد
  // العتبات الموثقة (لا حد ائتماني ولا شروط دفع في النظام — القواعد مشتقة ومعلنة):
  // - متأخر: فاتورة مؤكدة بمتبقٍ>0 وعمر>30 يوم (سابقة Dashboard OVERDUE_DAYS)
  // - منقطع: فواتير مؤكدة قبل البداية + صفر داخل الفترة + آخر شراء قبل >45 يوم من اليوم
  // - منخفض النشاط: فاتورة واحدة داخل الفترة وقيمتها دون وسيط قيم عملاء الفترة
  // - متعثر: متأخر AND (أقدم فاتورة غير مسددة >60 يوم OR المتأخر ≥50% من إجمالي دينه)
  // - الربح = Σ(كمية×(سعر البيع−cost_snapshot لحظة التأكيد)) − المرتجعات بسعر/تكلفة الأصل
  // - المسودات والفواتير المحذوفة بلا أثر أصلاً — تُحتسب المؤكدة فقط
  intel(q, ctx) {
    if (!ctx || ctx.role === 'guest') throw Object.assign(new Error('سجل الدخول أولاً'), { code: 401 });
    if (!Auth.can(ctx.role, 'sales', 'view')) throw Object.assign(new Error('غير مصرح لك بتحليلات المبيعات'), { code: 403 });
    const money = !!Auth.can(ctx.role, 'finance', 'account');
    const t = now().slice(0, 10);
    let to = String((q && q.get('to')) || t);
    let from = String((q && q.get('from')) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw Object.assign(new Error('تاريخ النهاية غير صالح'), { code: 400 });
    if (!from) {
      const days = Math.max(1, Math.min(730, Number((q && q.get('days')) || 30) || 30));
      const dd = new Date(to + 'T00:00:00Z'); dd.setUTCDate(dd.getUTCDate() - (days - 1));
      from = dd.toISOString().slice(0, 10);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw Object.assign(new Error('تاريخ البداية غير صالح'), { code: 400 });
    if (from > to) throw Object.assign(new Error('البداية بعد النهاية'), { code: 400 });
    const n = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const pToD = new Date(from + 'T00:00:00Z'); pToD.setUTCDate(pToD.getUTCDate() - 1);
    const pTo = pToD.toISOString().slice(0, 10);
    const pFromD = new Date(from + 'T00:00:00Z'); pFromD.setUTCDate(pFromD.getUTCDate() - n);
    const pFrom = pFromD.toISOString().slice(0, 10);
    const inR = ds => ds >= from && ds <= to;
    const inP = ds => ds >= pFrom && ds <= pTo;
    const age = ds => Math.round((Date.parse(t) - Date.parse(ds)) / 86400000);
    const d = db.load();
    const md = mdata();
    const custName = {};
    for (const c of md.customers || []) custName[c.id] = c.name;
    const finIds = new Set((md.items || []).filter(it => {
      const c = (md.categories || []).find(x => x.id === Number(it.category_id));
      return c && c.main === 'منتج نهائي';
    }).map(it => ({ id: it.id, name: it.name, unit: it.unit })));
    const finById = {};
    for (const it of md.items || []) finById[it.id] = it;
    const views = {};
    for (const o of d.invoices || []) views[o.id] = invoiceView(d, o);
    const conf = (d.invoices || []).filter(o => o.status === 'مؤكدة');
    const inCur = conf.filter(o => inR(String(o.date || '')));
    const inPrev = conf.filter(o => inP(String(o.date || '')));
    // ---- المنتجات: مبيعات الفترة + مرتجعاتها + مقارنة سابقة ----
    const pm = {};
    const padd = (id, name, unit, qty, rev, cost) => {
      pm[id] = pm[id] || { item_id: id, name, unit: unit || '', qty: 0, revenue: 0, cost: 0, prevRevenue: 0, prevCost: 0 };
      pm[id].qty = r2(pm[id].qty + qty);
      pm[id].revenue = r2(pm[id].revenue + rev);
      pm[id].cost = r2(pm[id].cost + cost);
    };
    for (const o of inCur) for (const l of o.lines || []) {
      const c = Number(l.cost_snapshot || 0);
      padd(l.item_id, l.item_name, l.unit, Number(l.qty || 0), Number(l.qty || 0) * Number(l.price || 0), Number(l.qty || 0) * c);
    }
    for (const rt of d.returns || []) {
      if (!inR(String(rt.date || '').slice(0, 10))) continue;
      const inv = (d.invoices || []).find(o => o.id === rt.invoice_id);
      if (!inv || inv.status !== 'مؤكدة') continue;
      for (const l of rt.lines || []) {
        const ol = (inv.lines || []).find(x => x.item_id === l.item_id);
        const pr = Number(ol ? ol.price : 0), cc = Number(ol && ol.cost_snapshot != null ? ol.cost_snapshot : 0);
        const it = finById[l.item_id] || {};
        padd(l.item_id, (ol && ol.item_name) || it.name || ('#' + l.item_id), (ol && ol.unit) || it.unit, -Number(l.qty || 0), -Number(l.qty || 0) * pr, -Number(l.qty || 0) * cc);
      }
    }
    for (const o of inPrev) for (const l of o.lines || []) {
      pm[l.item_id] = pm[l.item_id] || { item_id: l.item_id, name: l.item_name, unit: l.unit || '', qty: 0, revenue: 0, cost: 0, prevRevenue: 0, prevCost: 0 };
      pm[l.item_id].prevRevenue = r2(pm[l.item_id].prevRevenue + Number(l.qty || 0) * Number(l.price || 0));
      pm[l.item_id].prevCost = r2(pm[l.item_id].prevCost + Number(l.qty || 0) * Number(l.cost_snapshot || 0));
    }
    const products = Object.values(pm).map(p => {
      const profit = r2(p.revenue - p.cost);
      return {
        item_id: p.item_id, name: p.name, unit: p.unit, qty: p.qty, revenue: p.revenue,
        cost: money ? p.cost : null, profit: money ? profit : null,
        margin: money && p.revenue > 0 ? Math.round(profit / p.revenue * 1000) / 10 : (money ? 0 : null),
        growth: p.prevRevenue > 0 ? Math.round((p.revenue - p.prevRevenue) / p.prevRevenue * 1000) / 10 : null,
        prevRevenue: p.prevRevenue
      };
    }).sort((a, b) => b.revenue - a.revenue);
    // الراكدة: منتجات تامة بلا بيع في الفترة + آخر بيع على الإطلاق
    const soldIds = new Set(inCur.flatMap(o => (o.lines || []).map(l => l.item_id)));
    const lastSale = {};
    for (const o of conf) for (const l of o.lines || []) {
      const ds = String(o.date || '');
      if (!lastSale[l.item_id] || ds > lastSale[l.item_id]) lastSale[l.item_id] = ds;
    }
    const stagnant = [...finIds].filter(it => !soldIds.has(it.id)).map(it => ({
      item_id: it.id, name: it.name,
      lastSale: lastSale[it.id] || null,
      stagnantDays: lastSale[it.id] ? age(lastSale[it.id]) : null
    })).sort((a, b) => (b.stagnantDays || 0) - (a.stagnantDays || 0));
    // ---- العملاء: الفترة + الديون (كل الفترات) ----
    const cm = {};
    const cadd = (cid, o) => {
      const v = views[o.id] || invoiceView(d, o);
      cm[cid] = cm[cid] || { customer_id: cid, name: o.customer_name || custName[cid] || ('#' + cid), total: 0, count: 0, last: '' };
      cm[cid].total = r2(cm[cid].total + Number(o.total || 0));
      cm[cid].count++;
      if (!cm[cid].last || String(o.date || '') > cm[cid].last) cm[cid].last = String(o.date || '');
      return v;
    };
    for (const o of inCur) cadd(o.customer_id, o);
    const custTotals = Object.values(cm).map(c => c.total).sort((a, b) => a - b);
    const median = custTotals.length ? custTotals[Math.floor(custTotals.length / 2)] : 0;
    const customers = Object.values(cm).map(c => ({
      customer_id: c.customer_id, name: c.name, total: c.total, count: c.count,
      avg: c.count ? r2(c.total / c.count) : 0, last: c.last,
      lowActivity: c.count === 1 && c.total < median
    })).sort((a, b) => b.total - a.total);
    // المنقطعون: شراء مؤكد قبل الفترة + صفر داخلها + آخر شراء قبل >45 يوم
    const everByCust = {};
    for (const o of conf) {
      const ds = String(o.date || '');
      const e = everByCust[o.customer_id] || (everByCust[o.customer_id] = { last: '', before: false });
      if (ds > e.last) e.last = ds;
      if (ds < from) e.before = true;
    }
    const churned = Object.entries(everByCust)
      .filter(([cid, e]) => e.before && !cm[cid] && age(e.last) > 45)
      .map(([cid, e]) => {
        const cidN = Number(cid);
        const tot = r2(conf.filter(o => o.customer_id === cidN || String(o.customer_id) === String(cid)).reduce((s, o) => s + Number(o.total || 0), 0));
        return { customer_id: Number.isFinite(cidN) ? cidN : cid, name: custName[cidN] || custName[cid] || ('#' + cid), last: e.last, daysSince: age(e.last), pastTotal: tot };
      }).sort((a, b) => b.daysSince - a.daysSince);
    // الديون: رصيد حقيقي (افتتاحي + مفوتر − محصل − مرتجعات) + أقدم فاتورة غير مسددة
    const debts = [];
    if (money) {
      const openMap = {};
      for (const c of md.customers || []) openMap[c.id] = Number(c.opening_debt || 0);
      const byCust = {};
      const centry = (cid, nm) => byCust[cid] || (byCust[cid] = { name: nm || custName[Number(cid)] || custName[cid] || ('#' + cid), debt: r2(openMap[Number(cid)] || openMap[cid] || 0), collected: 0, overdue: 0, oldest: null, oldestAge: 0, oldestNum: '' });
      for (const c of md.customers || []) { if (Number(c.opening_debt || 0) > 0) centry(c.id, c.name); }
      for (const o of conf) {
        const v = views[o.id] || invoiceView(d, o);
        const e = centry(o.customer_id, o.customer_name);
        e.debt = r2(e.debt + Number(v.remaining || 0));
        const rem = Number(v.remaining || 0);
        if (rem > 0) {
          const a = age(String(o.date || ''));
          if (a > 30) e.overdue = r2(e.overdue + rem);
          if (!e.oldest || String(o.date || '') < e.oldest) { e.oldest = String(o.date || ''); e.oldestAge = a; e.oldestNum = o.num; }
        }
      }
      for (const x of d.receipts || []) {
        const amt = Number(x.amount || 0);
        if (!(amt > 0) || !inR(String(x.date || '').slice(0, 10))) continue;
        const e = centry(x.customer_id, x.customer_name);
        e.collected = r2(e.collected + amt);
      }
      for (const [cid, e] of Object.entries(byCust)) {
        if (!(e.debt > 0) && !(e.collected > 0) && !(e.overdue > 0)) continue;
        debts.push({
          customer_id: cid, name: e.name, debt: e.debt, collected: e.collected, overdue: e.overdue,
          oldest: e.oldest, oldestAge: e.oldestAge, oldestNum: e.oldestNum,
          distressed: e.overdue > 0 && (e.oldestAge > 60 || (e.debt > 0 && e.overdue >= e.debt * 0.5)),
          distressReason: e.overdue > 0 ? (e.oldestAge > 60 ? 'أقدم فاتورة غير مسددة تجاوزت 60 يوم' : (e.debt > 0 && e.overdue >= e.debt * 0.5 ? 'المتأخر ≥50% من إجمالي الدين' : '')) : ''
        });
      }
      debts.sort((a, b) => b.debt - a.debt);
    }
    // ---- KPIs والمقارنة ----
    const rev = r2(products.reduce((s, p) => s + p.revenue, 0));
    const prof = money ? r2(products.reduce((s, p) => s + (p.profit || 0), 0)) : null;
    const prevRev = r2(Object.values(pm).reduce((s, p) => s + p.prevRevenue, 0));
    const prevProf = money ? r2(Object.values(pm).reduce((s, p) => s + (p.prevRevenue - p.prevCost), 0)) : null;
    const prevCust = new Set(inPrev.map(o => o.customer_id)).size;
    const collected = money ? r2(debts.reduce((s, x) => s + x.collected, 0)) : null;
    const debtTot = money ? r2(debts.reduce((s, x) => s + x.debt, 0)) : null;
    const overdueTot = money ? r2(debts.reduce((s, x) => s + x.overdue, 0)) : null;
    const pct = (a, b) => (b > 0 ? Math.round((a - b) / b * 1000) / 10 : null);
    return {
      data: {
        from, to, prev: { from: pFrom, to: pTo }, money,
        kpis: {
          revenue: rev, profit: prof, margin: money && rev > 0 ? Math.round(prof / rev * 1000) / 10 : (money ? 0 : null),
          customers: customers.length, invoices: inCur.length,
          debts: debtTot, collected, overdue: overdueTot, hasData: inCur.length > 0
        },
        compare: {
          revenue: { cur: rev, prev: prevRev, ch: pct(rev, prevRev) },
          profit: money ? { cur: prof, prev: prevProf, ch: pct(prof, prevProf) } : null,
          customers: { cur: customers.length, prev: prevCust, ch: pct(customers.length, prevCust) }
        },
        products, stagnant, customers, churned, debts,
        notes: 'المتأخر >30 يوم بمتبقٍ — المنقطع: شراء سابق + صفر بالفترة + آخر شراء >45 يوم — المتعثر قاعدة مشتقة (لا حد ائتماني بالنظام) — المبيعات والأرباح بعد خصم المرتجعات'
      }
    };
  }
};

module.exports = Sales;

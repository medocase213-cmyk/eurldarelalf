// الإنتاج: أمر OF ← بدء ← إغلاق باستهلاك FEFO للمواد + التغليف + لوت منتج تام بتكلفة حقيقية
// القواعد: لا سالب — المغلق نهائي — المنتج التام بطاقة مادة — الهدر يُحمّل على التكلفة
// التغليف (أكياس/خيوط): سطور على الأمر لا في التركيبة — يُستهلك من الخام عند الإغلاق ويُحمّل على التكلفة
const jstore = require('./jstore');
const System = require('./system');
const Auth = require('./auth');
const mstore = require('./store');
const Stock = require('./stock');

const db = jstore('production.json', { seq: { order: 1, order_num: 1 }, orders: [] });
const now = () => new Date().toISOString();
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const OH = 0.05;

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
function plusDays(base, n) {
  const t = Date.parse(base) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
// أشهر ميلادية مع تثبيت آخر الشهر عند التجاوز (31 جانفي + 3 أشهر = 30 أفريل لا 1 ماي)
function plusMonths(base, n) {
  const d = new Date(Date.parse(String(base).slice(0, 10) + 'T00:00:00Z'));
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + Number(n || 0));
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
function mdata() { return mstore.load(); }
function getFormula(md, id) {
  const f = md.formulas_ref.find(x => x.id === Number(id));
  if (!f) err('التركيبة غير موجودة');
  if (f.status === 'متوقفة') err('التركيبة ' + (f.num || '') + ' متوقفة — اعتمد نسخة نشطة');
  const items = (md.formula_items || []).filter(x => x.formula_id === f.id);
  if (!items.length) err('التركيبة بلا عناصر');
  return { f, items };
}
function getProduct(md, id) {
  const p = md.items.find(x => x.id === Number(id));
  if (!p) err('المنتج التام غير موجود — عرّفه بطاقة مادة أولاً');
  if (p.status === 'متوقفة') err('المنتج ' + p.name + ' موقف');
  const cat = (md.categories || []).find(c => c.id === Number(p.category_id));
  if (!cat || cat.main !== 'منتج نهائي') {
    err('المخرج منتج تام فقط: ' + p.name + ' مصنفة «' + (cat ? cat.main : 'بلا تصنيف') + '» — أنشئ بطاقة بتصنيف منتج نهائي');
  }
  return p;
}
// الاحتياج النظري لكمية إنتاج فعلية/مخططة
function theoretical(items, qty) {
  const totQ = r2(items.reduce((s, x) => s + Number(x.qty || 0), 0));
  if (!(totQ > 0)) err('مجموع التركيبة صفر');
  const k = qty / totQ;
  return items.map(x => ({ item_id: x.item_id, item_name: x.item_name, unit: x.unit, qty: r2(Number(x.qty || 0) * k) }));
}
// ---- التغليف: أصناف تُشترى وتُخزّن كخام لكنها تلبس المنتج لا تدخل الخلطة ----
function getPackItem(md, id) {
  const p = md.items.find(x => x.id === Number(id));
  if (!p) err('صنف التغليف غير موجود في البيانات الأساسية');
  if (p.status === 'متوقفة') err('صنف التغليف ' + p.name + ' موقف');
  const cat = (md.categories || []).find(c => c.id === Number(p.category_id));
  if (cat && cat.main === 'منتج نهائي') err('التغليف لا يكون منتجاً نهائياً (' + p.name + ') — أنشئ بطاقته بتصنيف «تعبئة وتغليف»');
  return p;
}
function cleanPacking(md, packing) {
  if (packing === undefined) return undefined;
  if (!Array.isArray(packing)) err('التغليف: قائمة أصناف');
  const out = [];
  for (const ln of packing) {
    const p = getPackItem(md, ln.item_id);
    const per = toNum(ln.per_q, 'تغليف ' + p.name + ' (لكل قنطار)');
    if (!(per > 0)) err('كمية التغليف لكل قنطار أكبر من صفر (' + p.name + ')');
    if (out.some(o => o.item_id === p.id)) err('صنف التغليف مكرر: ' + p.name);
    out.push({ item_id: p.id, item_name: p.name, unit: p.unit, per_q: r2(per) });
  }
  return out;
}
// احتياج التغليف لكمية إنتاج: الأصناف بالوحدة (كيس) تُقرب للأعلى — لا نصف كيس
function packingNeeds(packing, qty) {
  return (packing || []).map(l => {
    const need = Number(l.per_q || 0) * Number(qty || 0);
    const q = l.unit === 'وحدة' ? Math.ceil(need - 1e-9) : r2(need);
    return { item_id: l.item_id, item_name: l.item_name, unit: l.unit, per_q: l.per_q, qty: q };
  }).filter(l => l.qty > 0);
}
function checkAvail(lines, label) {
  const inv = require('./inventory-check');
  return inv.checkMulti(lines, label);
}

const Prod = {
  kpi() {
    const d = db.load();
    const done = d.orders.filter(o => o.status === 'مكتملة');
    const t = now().slice(0, 10);
    const weekAgo = plusDays(t, -6);
    const month = t.slice(0, 7);
    const sum = arr => r2(arr.reduce((s, o) => s + Number(o.actual_qty || 0), 0));
    const inMonth = done.filter(o => String(o.closed_at || '').slice(0, 7) === month);
    const th = inMonth.reduce((s, o) => s + Number(o.theoretical_total || 0), 0);
    const wa = inMonth.reduce((s, o) => s + Number(o.waste || 0), 0);
    return {
      data: {
        today: sum(done.filter(o => String(o.closed_at || '').slice(0, 10) === t)),
        week: sum(done.filter(o => String(o.closed_at || '').slice(0, 10) >= weekAgo)),
        month: sum(inMonth),
        wip: d.orders.filter(o => o.status === 'قيد التنفيذ').length,
        orders: d.orders.length,
        wastePct: th > 0 ? Math.round((wa / th) * 1000) / 10 : 0
      }
    };
  },

  list() {
    const d = db.load();
    return { data: d.orders.slice().sort((a, b) => (a.id < b.id ? 1 : -1)) };
  },
  get(id) {
    const d = db.load();
    const o = d.orders.find(x => x.id === Number(id));
    if (!o) err('الأمر غير موجود', 404);
    return { data: o };
  },

  add(b, ctx) {
    if (!Auth.can(ctx.role, 'production', 'order')) err('الإنتاج: المدير أو أمين المخزن فقط', 403);
    const md = mdata();
    const { f } = getFormula(md, b.formula_id);
    const p = getProduct(md, b.product_id);
    // السحب تلقائي من كل مخازن الخام (FEFO شامل) — بلا مخزن مصدر
    // مخزن المنتج (تام) ضروري ويُفرض نوعه
    const dst = md.warehouses.find(w => w.id === Number(b.dst_wh));
    if (!dst) err('مخزن المنتج مطلوب');
    if (dst.type !== 'منتج نهائي') err('مخزن المنتج للمنتج التام فقط (' + dst.name + ' مخزن ' + (dst.type || '؟') + ')');
    const planned = toNum(b.planned_qty, 'الكمية المخططة');
    if (!(planned > 0)) err('الكمية المخططة أكبر من صفر');
    const packing = cleanPacking(md, b.packing === undefined ? [] : b.packing) || [];
    const d = db.load();
    const year = validDate(b.date || now().slice(0, 10), 'التاريخ').slice(0, 4);
    const row = {
      id: d.seq.order++, num: System.formatNum('production', { year, n: d.seq.order_num++ }),
      formula_id: f.id, formula_num: f.num, formula_name: f.name,
      product_id: p.id, product_name: p.name, product_unit: p.unit,
      planned_qty: r2(planned), date: validDate(b.date || now().slice(0, 10), 'التاريخ'),
      src_wh: null, src_wh_name: 'تلقائي (مخازن الخام)', dst_wh: dst.id, dst_wh_name: dst.name,
      status: 'مسودة', note: String(b.note || '').trim(),
      packing, packing_theo: packingNeeds(packing, r2(planned)),
      actual_qty: 0, waste: 0, theoretical: [], actual_lines: [], finished: null,
      created_by: ctx.user, created_at: now(), updated_at: now()
    };
    row.theoretical = theoretical((md.formula_items || []).filter(x => x.formula_id === f.id), r2(planned));
    row.theoretical_total = r2(row.theoretical.reduce((s, l) => s + l.qty, 0));
    d.orders.push(row);
    db.save(d);
    return { data: row };
  },
  update(id, b, ctx) {
    if (!Auth.can(ctx.role, 'production', 'order')) err('الإنتاج: المدير أو أمين المخزن فقط', 403);
    const md = mdata();
    const d = db.load();
    const o = d.orders.find(x => x.id === Number(id));
    if (!o) err('الأمر غير موجود', 404);
    if (o.status !== 'مسودة') err('التعديل في مسودة فقط');
    if (b.formula_id !== undefined || b.product_id !== undefined) {
      const { f } = getFormula(md, b.formula_id !== undefined ? b.formula_id : o.formula_id);
      const p = getProduct(md, b.product_id !== undefined ? b.product_id : o.product_id);
      o.formula_id = f.id; o.formula_num = f.num; o.formula_name = f.name;
      o.product_id = p.id; o.product_name = p.name; o.product_unit = p.unit;
    }
    if (b.dst_wh !== undefined) {
      const dst = md.warehouses.find(w => w.id === Number(b.dst_wh));
      if (!dst) err('مخزن المنتج غير موجود');
      if (dst.type !== 'منتج نهائي') err('مخزن المنتج للمنتج التام فقط (' + dst.name + ' مخزن ' + (dst.type || '؟') + ')');
      o.dst_wh = dst.id; o.dst_wh_name = dst.name;
    }
    if (b.planned_qty !== undefined) {
      const pl = toNum(b.planned_qty, 'الكمية المخططة');
      if (!(pl > 0)) err('الكمية المخططة أكبر من صفر');
      o.planned_qty = r2(pl);
    }
    if (b.date !== undefined) o.date = validDate(b.date, 'التاريخ');
    if (b.note !== undefined) o.note = String(b.note || '').trim();
    if (b.packing !== undefined) {
      o.packing = cleanPacking(md, b.packing) || [];
      o.packing_theo = packingNeeds(o.packing, o.planned_qty);
    }
    const { items } = getFormula(md, o.formula_id);
    o.theoretical = theoretical(items, o.planned_qty);
    o.theoretical_total = r2(o.theoretical.reduce((s, l) => s + l.qty, 0));
    o.updated_at = now();
    db.save(d);
    return { data: o };
  },
  remove(id, ctx) {
    if (!Auth.can(ctx.role, 'production', 'order')) err('الإنتاج: المدير أو أمين المخزن فقط', 403);
    const d = db.load();
    const i = d.orders.findIndex(x => x.id === Number(id));
    if (i < 0) err('الأمر غير موجود', 404);
    if (d.orders[i].status !== 'مسودة') err('الحذف في مسودة فقط — المغلق نهائي');
    d.orders.splice(i, 1);
    db.save(d);
    return { ok: true };
  },
  start(id, ctx) {
    if (!Auth.can(ctx.role, 'production', 'execute')) err('الإنتاج: المدير أو أمين المخزن فقط', 403);
    const md = mdata();
    const d = db.load();
    const o = d.orders.find(x => x.id === Number(id));
    if (!o) err('الأمر غير موجود', 404);
    if (o.status !== 'مسودة') err('البدء من مسودة فقط');
    // الأكياس تُخصم تلقائياً عند البيع (2/قنطار) — التغليف على الأمر اختياري للتوثيق فقط
    const { items } = getFormula(md, o.formula_id);
    checkAvail(theoretical(items, o.planned_qty), 'بدء التنفيذ');
    // التغليف يحجز مع العلف — نفاد الأكياس يوقف البدء قبل هدر الوقت
    const pkPlan = packingNeeds(o.packing, o.planned_qty);
    if (pkPlan.length) checkAvail(pkPlan.map(n => ({ item_id: n.item_id, qty: n.qty })), 'بدء التنفيذ (التغليف)');
    o.status = 'قيد التنفيذ';
    o.started_by = ctx.user; o.started_at = now(); o.updated_at = now();
    db.save(d);
    return { data: o };
  },
  cancel(id, ctx) {
    if (!Auth.can(ctx.role, 'production', 'execute')) err('الإنتاج: المدير أو أمين المخزن فقط', 403);
    const d = db.load();
    const o = d.orders.find(x => x.id === Number(id));
    if (!o) err('الأمر غير موجود', 404);
    if (o.status === 'مكتملة') err('المغلق نهائي — لا إلغاء');
    if (o.status === 'ملغاة') err('ملغاة مسبقاً');
    // حماية الصرفيات المعلقة: أمر صُرف له مخزون لا يُلغى (الإلغاء لا يعكس الصرف) —
    // أغلقه أو سوّ صرفياته أولاً حتى لا تضيع الكميات بلا منتج
    try {
      const invDb0 = require('./jstore')('inventory.json', { lots: [], movements: [] });
      const hasOut = ((invDb0.load().movements) || []).some(m => m.type === 'خروج' && m.source && m.source.kind === 'إنتاج' && String(m.source.num || '') === String(o.num || ''));
      if (hasOut) err('للأمر «' + o.num + '» صرفيات مخزون مسجلة — الإلغاء سيتركها معلقة بلا منتج؛ أغلق الأمر أو سوّها أولاً', 409);
    } catch (e) { if (e && e.code === 409) throw e; }
    o.status = 'ملغاة';
    o.updated_at = now();
    db.save(d);
    return { data: o };
  },
  close(id, b, ctx) {
    if (!Auth.can(ctx.role, 'production', 'execute')) err('الإنتاج: المدير أو أمين المخزن فقط', 403);
    const md = mdata();
    const d = db.load();
    const o = d.orders.find(x => x.id === Number(id));
    if (!o) err('الأمر غير موجود', 404);
    if (o.status !== 'قيد التنفيذ') err('الإغلاق لأمر قيد التنفيذ فقط (ابدأ التنفيذ أولاً)');
    const actual = toNum(b.actual_qty, 'الكمية المنتجة فعلاً');
    if (!(actual > 0)) err('الكمية المنتجة أكبر من صفر');
    // قاعدة المصنع: الفعلي لا يتجاوز المخطط — الهدر = الفرق تلقائياً (يُتجاهل أي هدر مرسل)
    if (actual > Number(o.planned_qty || 0) + 1e-9) err('الكمية المنتجة (' + actual + ') تتجاوز المخطط (' + o.planned_qty + ')');
    const waste = r2(Number(o.planned_qty || 0) - actual);
    const { items } = getFormula(md, o.formula_id);
    const theo = theoretical(items, actual);
    const theoTot = r2(theo.reduce((s, l) => s + l.qty, 0));
    // النظري المرجعي يُحسب للمخطط دائماً (مثل الإنشاء/التعديل) حتى تبقى المعادلة: نظري − فعلي = هدر —
    // تفاصيل الفعلي ( actual_lines) تبقى مبنية على الفعلي كما هي للتدقيق
    // الاستهلاك = النظري + الهدر موزعاً بنفس الخلطة
    const k = theoTot > 0 ? (actual + waste) / actual : 1;
    const needs = theo.map(l => ({ ...l, need: r2(l.qty * k) }));
    checkAvail(needs.map(n => ({ item_id: n.item_id, qty: n.need })), 'الإغلاق');
    // التغليف حسب الفعلي (بلا هدر — الأكياس للمنتج لا للهدر)
    const pkNeeds = packingNeeds(o.packing, actual);
    if (pkNeeds.length) checkAvail(pkNeeds.map(n => ({ item_id: n.item_id, qty: n.qty })), 'الإغلاق (التغليف)');
    // فحوصات ما قبل الصرف (لا تمس المخزون — الفشل هنا آمن ويُعاد الإغلاق بعده بلا أثر مزدوج):
    // 1) منع الصرف المكرر: أي خروج سابق لنفس الأمر يعني إغلاقاً سابقاً (نقر مزدوج/إعادة محاولة)
    // 2) مراقبة الخلط: التخزين فوق منتج مختلف يستلزم إقراراً صريحاً
    try {
      const invDb = require('./jstore')('inventory.json', { lots: [] });
      const invD = invDb.load();
      const prior = ((invD.movements) || []).some(m => m.type === 'خروج' && m.source && m.source.kind === 'إنتاج' && String(m.source.num || '') === String(o.num || ''));
      if (prior) err('صُرف لهذا الأمر مسبقاً (' + o.num + ') — راجع حركات المخزون؛ الإغلاق المكرر مرفوض لمنع الخصم المزدوج', 409);
      const allLots = ((invD.lots) || []).filter(l => l.warehouse_id === o.dst_wh && r2(Number(l.remaining || 0)) > 0 && Number(l.item_id) !== Number(o.product_id));
      const others = [...new Set(allLots.map(l => l.item_name))];
      // المخازن الثابتة (المواد الأولية/المنتج النهائي) تستضيف كل الأصناف بكميات غير محدودة — بلا فحص خلط
      const dstWh = (md.warehouses || []).find(w => w.id === Number(o.dst_wh));
      if (others.length && !b.allow_mix && !(dstWh && dstWh.fixed)) {
        err('تحذير خلط خطير: مخزن «' + o.dst_wh_name + '» يحتوي منتجات أخرى (' + others.join('، ') + ') — تخزين «' + o.product_name + '» فوقها يخلط الأصناف ويضيع تتبع اللوتات! راجع مخزن الوجهة، أو أقرّ الخلط صراحة للمتابعة.', 409);
      }
    } catch (e) { if (e && e.code === 409) throw e; }
    // الصرف FEFO الشامل لمخازن الخام + التقييم بأسعار اللوتات (أول كتابة للمخزون في الإغلاق)
    const inv = require('./inventory-check');
    const consumed = inv.consumeMulti(needs.map(n => ({ item_id: n.item_id, item_name: n.item_name, unit: n.unit, qty: n.need, theo: n.qty })), { kind: 'إنتاج', num: o.num }, ctx.user, 'أمر ' + o.num);
    let packConsumed = [];
    if (pkNeeds.length) {
      packConsumed = inv.consumeMulti(pkNeeds.map(n => ({ item_id: n.item_id, item_name: n.item_name, unit: n.unit, qty: n.qty, theo: n.qty })), { kind: 'إنتاج', num: o.num }, ctx.user, 'تغليف أمر ' + o.num);
    }
    const rawValue = r2(consumed.reduce((s, c) => s + c.value, 0));
    const packValue = r2(packConsumed.reduce((s, c) => s + c.value, 0));
    const totalValue = r2(rawValue + packValue);
    const unitCost = r2((totalValue * (1 + OH)) / actual);
    const prodDate = validDate(b.date || now().slice(0, 10), 'تاريخ الإنتاج');
    // الصلاحية الافتراضية: 3 أشهر من تاريخ الإنتاج لجميع المنتجات النهائية تلقائياً.
    // تُقرأ من بطاقة المنتج (shelf_months) — وأي بطاقة قديمة بلا مدة تُعامل كـ 3 أشهر.
    // تاريخ صريح من المستخدم يتجاوز التلقائي; لا يمس المواد الأخرى.
    let shelfM = 3;
    try {
      const prd = (md.items || []).find(x => x.id === Number(o.product_id));
      const v = Number(prd && prd.shelf_months);
      if (Number.isFinite(v) && v > 0 && v <= 60) shelfM = v;
    } catch {}
    const expiry = b.expiry && String(b.expiry).trim() ? validDate(b.expiry, 'انتهاء المنتج') : plusMonths(prodDate, shelfM);
    const lot = Stock.receiveLot({
      item_id: o.product_id, item_name: o.product_name, unit: o.product_unit,
      qty: actual, cost: unitCost, warehouse_id: o.dst_wh, warehouse_name: o.dst_wh_name,
      expiry, qc: 'مقبولة', order_num: o.num, date: prodDate, user: ctx.user
    });
    o.actual_qty = r2(actual); o.waste = r2(waste);
    o.theoretical = theoretical(items, o.planned_qty);
    o.theoretical_total = r2(o.theoretical.reduce((s, l) => s + l.qty, 0));
    o.packing_used = pkNeeds.map(n => {
      const c = packConsumed.find(x => x.item_id === n.item_id);
      return { ...n, value: c ? c.value : 0 };
    });
    o.actual_lines = consumed.map(c => ({ kind: 'علف', item_id: c.item_id, item_name: c.item_name, unit: c.unit, theo: c.theo, extra: c.extra, out: c.out, value: c.value }))
      .concat(packConsumed.map(c => ({ kind: 'تغليف', item_id: c.item_id, item_name: c.item_name, unit: c.unit, theo: c.theo, extra: c.extra, out: c.out, value: c.value })));
    o.raw_value = rawValue; o.pack_value = packValue; o.unit_cost = unitCost;
    o.finished = { lot_id: lot.id, lot_no: lot.lot_no, qty: actual, expiry };
    o.close_note = String(b.note || '').trim();
    o.status = 'مكتملة';
    o.closed_by = ctx.user; o.closed_at = now(); o.updated_at = now();
    db.save(d);
    return { data: o };
  },

  lots() {
    const inv = require('./inventory-check');
    return { data: inv.finishedLots() };
  }
};

module.exports = Prod;

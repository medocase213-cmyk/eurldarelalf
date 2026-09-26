// المخزون: دفتر حركات + صرف FEFO (الأقرب انتهاء أولاً) + تسويات
// القواعد: الرصيد مشتق دائماً — لا سالب أبداً — المرفوض والم pending محجوبان عن الصرف
const jstore = require('./jstore');
const System = require('./system');
const Auth = require('./auth');
const mstore = require('./store');
const Fefo = require('./fefo');

const db = jstore('inventory.json', {
  seq: { lot: 1, lot_num: 1, mov: 1, count: 1, count_num: 1, waste: 1, transfer_num: 1 },
  lots: [], movements: [], counts: [], wastes: []
});
const now = () => new Date().toISOString();
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const EXPIRY_NEAR_DAYS = 60;
const NEAR_MIN_FACTOR = 1.2;
const WASTE_REASONS = ['انتهاء صلاحية', 'تلف بالتخزين', 'تلف بالنقل', 'سرقة', 'أخرى'];

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
function load() {
  const d = db.load();
  if (!Array.isArray(d.lots)) d.lots = [];
  if (!Array.isArray(d.movements)) d.movements = [];
  if (!Array.isArray(d.counts)) d.counts = [];
  if (!Array.isArray(d.wastes)) d.wastes = [];
  d.seq = d.seq || {};
  for (const k of ['lot', 'lot_num', 'mov', 'count', 'count_num', 'waste', 'transfer_num']) {
    if (!Number.isInteger(d.seq[k]) || d.seq[k] < 1) d.seq[k] = 1;
  }
  return d;
}
function mdata() { return mstore.load(); }
function getItem(md, id) {
  const it = md.items.find(x => x.id === Number(id));
  if (!it) err('المادة غير موجودة في البيانات الأساسية');
  if (it.status === 'متوقفة') err('المادة ' + it.name + ' متوقفة');
  return it;
}
function getWh(md, id) {
  const w = md.warehouses.find(x => x.id === Number(id));
  if (!w) err('المخزن غير موجود');
  return w;
}
// الحالة الفعالة والمنتقي من الوحدة الموحدة (المصدر الوحيد — inventory-check يشاركها)
const effQc = Fefo.effQc;
const candidates = Fefo.candidates;
const available = Fefo.available;
function daysLeft(lot) {
  if (!lot.expiry) return null;
  return Math.ceil((Date.parse(lot.expiry) - Date.parse(now().slice(0, 10))) / 86400000);
}
// ترحيل اللوتات القديمة في الذاكرة فقط — بلا حفظ (الحفظ فقط في مسارات الكتابة)
// يمنع سباق الكتابة من مسارات القراءة + يزيل الكتابة الجانبية المتكررة
function backfill(d) {
  if (!Array.isArray(d.movements)) d.movements = [];
  if (!d.seq || !Number.isInteger(d.seq.mov) || d.seq.mov < 1) d.seq.mov = d.movements.length + 1;
  for (const lot of d.lots) {
    if (lot.remaining === undefined || lot.remaining === null) lot.remaining = r2(lot.qty);
    if (!lot.backfilled) {
      lot.backfilled = true;
      d.movements.push({
        id: d.seq.mov++, at: lot.created_at || now(), date: String(lot.date || lot.created_at || now()).slice(0, 10),
        item_id: lot.item_id, item_name: lot.item_name, unit: lot.unit, type: 'دخول',
        qty: r2(lot.qty), warehouse_from: '', warehouse_to: lot.warehouse_name || '',
        lot_id: lot.id, lot_no: lot.lot_no, expiry: lot.expiry || '',
        source: { kind: 'طلبية', num: lot.order_num || 'افتتاحي' },
        user: 'النظام', note: 'ترحيل تلقائي'
      });
    }
  }
}
function allocate(d, item_id, wh_id, qty, item_name) {
  return Fefo.planTakes(d, item_id, wh_id, qty, item_name);
}
function pushMov(d, m) {
  d.movements.push({ id: d.seq.mov++, at: now(), ...m });
}
function balances(d, md) {
  const map = {};
  for (const l of d.lots) {
    const rem = r2(Number(l.remaining || 0));
    if (rem <= 0) continue;
    const k = l.item_id + '|' + l.warehouse_id;
    if (!map[k]) {
      const it = md.items.find(x => x.id === l.item_id) || {};
      const wh = md.warehouses.find(x => x.id === l.warehouse_id) || {};
      map[k] = {
        item_id: l.item_id, item_name: l.item_name, unit: l.unit,
        warehouse_id: l.warehouse_id, warehouse_name: l.warehouse_name || wh.name || '',
        min_stock: Number(it.min_stock || 0), last_price: Number(it.last_price || 0), qty: 0, value: 0
      };
    }
    // التقييم بالتكلفة الفعلية للوتات (سعر الشراء للخام / تكلفة الإنتاج للتام)
    // بدل آخر سعر شراء الذي يبقى صفراً للمنتجات المصنعة داخلياً
    map[k].qty = r2(map[k].qty + rem);
    map[k].value = r2(map[k].value + rem * Number(l.cost_per_unit || 0));
  }
  const rows = Object.values(map).map(r => {
    const value = r2(r.value);
    const unit_cost = r.qty > 0 ? r2(value / r.qty) : 0;
    const st = (r.min_stock > 0 && r.qty <= r.min_stock) ? 'low' : (r.min_stock > 0 && r.qty <= r.min_stock * NEAR_MIN_FACTOR) ? 'near' : 'normal';
    return { ...r, value, unit_cost, status: st };
  });
  // تغطية النافد: صنف نشط بحد أدنى > 0 بلا أي لوت متبقٍّ (لم يُستلم/يُنتج قط، أو استُهلك كله)
  // بدون هذا السطر يختفي أخطر صنف من الرصيد وتنبيهات إعادة الطلب — النفاد الكامل لا يُنبَّه عليه أبداً
  try {
    const cats = new Map((md.categories || []).map(c => [Number(c.id), c.main]));
    const stocked = new Set();
    for (const l of (d.lots || [])) {
      if (r2(Number(l.remaining || 0)) > 0) stocked.add(Number(l.item_id));
    }
    for (const it of (md.items || [])) {
      if (!it || it.status === 'متوقفة') continue;
      const min = Number(it.min_stock || 0);
      if (!(min > 0)) continue;
      if (stocked.has(Number(it.id))) continue;
      const main = cats.get(Number(it.category_id));
      const wantType = main === 'منتج نهائي' ? 'منتج نهائي' : 'مواد أولية';
      const wh = (md.warehouses || []).find(w => w.type === wantType) || (md.warehouses || [])[0] || {};
      rows.push({
        item_id: it.id, item_name: it.name, unit: it.unit,
        warehouse_id: wh.id ?? null, warehouse_name: wh.name || '—',
        min_stock: min, last_price: Number(it.last_price || 0),
        qty: 0, value: 0, unit_cost: 0, status: 'low'
      });
    }
  } catch {}
  return rows.sort((a, b) => (`${a.item_name}${a.warehouse_name}` < `${b.item_name}${b.warehouse_name}` ? -1 : 1));
}

const Inv = {
  EXPIRY_NEAR_DAYS, NEAR_MIN_FACTOR,

  meta() {
    return { data: { waste_reasons: WASTE_REASONS, expiry_near_days: EXPIRY_NEAR_DAYS, near_min_factor: NEAR_MIN_FACTOR } };
  },

  kpi() {
    const d = load(); backfill(d);
    const md = mdata();
    const bal = balances(d, md);
    const low = bal.filter(r => r.status === 'low').length;
    const exp = d.lots.filter(l => Number(l.remaining || 0) > 0 && effQc(l) === 'مقبولة' && (() => { const dl = daysLeft(l); return dl !== null && dl >= 0 && dl <= EXPIRY_NEAR_DAYS; })()).length;
    const lastCount = d.counts.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const lastWaste = d.wastes.filter(w => w.status === 'مؤكدة').slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    // إجماليات حسب نوع المخزن: مواد أولية مقابل منتج نهائي
    const wtype = {};
    try {
      for (const w of (md.warehouses || [])) wtype[Number(w.id)] = w.type;
    } catch {}
    let rawQty = 0, finQty = 0, finValue = 0;
    for (const r of bal) {
      const t = wtype[Number(r.warehouse_id)];
      if (t === 'منتج نهائي') { finQty = r2(finQty + Number(r.qty || 0)); finValue = r2(finValue + Number(r.value || 0)); }
      else { rawQty = r2(rawQty + Number(r.qty || 0)); }
    }
    return {
      data: {
        lowCount: low,
        expiringCount: exp,
        lastCountDate: lastCount ? lastCount.date : null,
        stockValue: r2(bal.reduce((s, r) => s + r.value, 0)),
        rawQty, finQty, finValue,
        lastWaste: lastWaste ? { item: lastWaste.item_name, qty: lastWaste.qty, date: lastWaste.date } : null
      }
    };
  },

  balance() {
    const d = load(); backfill(d);
    return { data: balances(d, mdata()) };
  },

  lots() {
    const d = load(); backfill(d);
    return {
      data: d.lots.slice().sort((a, b) => (a.id < b.id ? 1 : -1)).map(l => ({
        ...l, remaining: r2(Number(l.remaining || 0)), qc_final: effQc(l),
        days_left: daysLeft(l), value: r2(Number(l.remaining || 0) * Number(l.cost_per_unit || 0))
      }))
    };
  },

  movements(from, to, q) {
    const d = load(); backfill(d);
    let rows = d.movements.slice().sort((a, b) => (a.id < b.id ? 1 : -1));
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) rows = rows.filter(m => String(m.date) >= from);
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) rows = rows.filter(m => String(m.date) <= to);
    if (q && String(q).trim()) rows = rows.filter(m => Object.values(m).join(' ').includes(String(q).trim()));
    return { data: rows };
  },

  transfer(b, ctx) {
    if (!Auth.can(ctx.role, 'inventory', 'move')) err('الحركات: أمين المخزن أو المدير فقط', 403);
    const md = mdata();
    const it = getItem(md, b.item_id);
    const wf = getWh(md, b.warehouse_from);
    const wt = getWh(md, b.warehouse_to);
    if (wf.id === wt.id) err('مخزن المصدر والوجهة مختلفان إجبارياً');
    const qty = toNum(b.qty, 'الكمية');
    if (!(qty > 0)) err('الكمية أكبر من صفر');
    if (!String(b.reason || '').trim()) err('سبب التحويل مطلوب');
    const d = load(); backfill(d);
    const takes = allocate(d, it.id, wf.id, qty, it.name);
    const tnum = System.formatNum('transfer', { year: new Date().getFullYear(), n: d.seq.transfer_num++ });
    for (const { lot, take } of takes) {
      lot.remaining = r2(Number(lot.remaining) - take);
      const nid = d.seq.lot++;
      const nlot = {
        id: nid, lot_no: lot.lot_no + '-T' + nid,
        item_id: lot.item_id, item_name: lot.item_name, unit: lot.unit,
        qty: take, remaining: take, cost_per_unit: lot.cost_per_unit,
        warehouse_id: wt.id, warehouse_name: wt.name,
        expiry: lot.expiry || '', qc: lot.qc || 'مقبولة', qc_final: effQc(lot) === 'مقبولة' ? 'مقبولة' : undefined,
        order_num: lot.order_num || '', date: now().slice(0, 10), backfilled: true, created_at: now()
      };
      if (!nlot.qc_final) delete nlot.qc_final;
      d.lots.push(nlot);
      pushMov(d, { date: now().slice(0, 10), item_id: it.id, item_name: it.name, unit: it.unit, type: 'تحويل', qty: -take, warehouse_from: wf.name, warehouse_to: wt.name, lot_id: lot.id, lot_no: lot.lot_no, expiry: lot.expiry || '', source: { kind: 'تحويل', num: tnum }, user: ctx.user, note: String(b.reason).trim() });
      pushMov(d, { date: now().slice(0, 10), item_id: it.id, item_name: it.name, unit: it.unit, type: 'تحويل', qty: take, warehouse_from: wf.name, warehouse_to: wt.name, lot_id: nid, lot_no: nlot.lot_no, expiry: lot.expiry || '', source: { kind: 'تحويل', num: tnum }, user: ctx.user, note: String(b.reason).trim() });
    }
    db.save(d);
    return { data: { num: tnum, qty } };
  },

  // ---- الجرد ----
  listCounts() {
    const d = load();
    return { data: d.counts.slice().sort((a, b) => (a.id < b.id ? 1 : -1)) };
  },
  addCount(b, ctx) {
    if (!Auth.can(ctx.role, 'inventory', 'move')) err('الجرد: أمين المخزن أو المدير فقط', 403);
    const md = mdata();
    const wh = getWh(md, b.warehouse_id);
    const d = load(); backfill(d);
    if (d.counts.some(c => c.warehouse_id === wh.id && c.status === 'مسودة')) err('يوجد جرد مفتوح لهذا المخزن — اعتمده أولاً');
    const seen = {};
    for (const l of d.lots) {
      if (l.warehouse_id !== wh.id || !(Number(l.remaining || 0) > 0)) continue;
      if (!seen[l.item_id]) seen[l.item_id] = { item_id: l.item_id, item_name: l.item_name, unit: l.unit, expected: 0 };
      seen[l.item_id].expected = r2(seen[l.item_id].expected + Number(l.remaining));
    }
    const lines = Object.values(seen).map(x => ({ ...x, actual: x.expected, diff: 0 }));
    const row = {
      id: d.seq.count++, num: System.formatNum('count', { year: new Date().getFullYear(), n: d.seq.count_num++ }),
      date: validDate(b.date || now().slice(0, 10), 'تاريخ الجرد'),
      warehouse_id: wh.id, warehouse_name: wh.name, lines,
      note: String(b.note || '').trim(), status: 'مسودة', by: ctx.user, created_at: now()
    };
    d.counts.push(row);
    db.save(d);
    return { data: row };
  },
  updateCount(id, b, ctx) {
    if (!Auth.can(ctx.role, 'inventory', 'move')) err('الجرد: أمين المخزن أو المدير فقط', 403);
    const d = load();
    const c = d.counts.find(x => x.id === Number(id));
    if (!c) err('الجرد غير موجود', 404);
    if (c.status !== 'مسودة') err('التعديل قبل الاعتماد فقط');
    if (Array.isArray(b.lines)) {
      for (const ln of b.lines) {
        const t = c.lines.find(x => x.item_id === Number(ln.item_id));
        if (!t) continue;
        const a = toNum(ln.actual, 'الفعلي لـ ' + t.item_name);
        if (a < 0) err('الكمية الفعلية لا تكون سالبة');
        t.actual = r2(a); t.diff = r2(a - t.expected);
      }
    }
    if (b.note !== undefined) c.note = String(b.note || '').trim();
    if (b.date !== undefined) c.date = validDate(b.date, 'تاريخ الجرد');
    db.save(d);
    return { data: c };
  },
  approveCount(id, ctx) {
    if (!Auth.can(ctx.role, 'inventory', 'approve')) err('اعتماد الجرد للمدير فقط', 403);
    const md = mdata();
    const d = load();
    const c = d.counts.find(x => x.id === Number(id));
    if (!c) err('الجرد غير موجود', 404);
    if (c.status !== 'مسودة') err('تم اعتماده مسبقاً');
    for (const ln of c.lines) {
      const diff = r2(Number(ln.diff || 0));
      if (diff === 0) continue;
      const it = md.items.find(x => x.id === ln.item_id) || { name: ln.item_name, unit: ln.unit, last_price: 0 };
      if (diff < 0) {
        const takes = allocate(d, ln.item_id, c.warehouse_id, -diff, ln.item_name);
        for (const { lot, take } of takes) {
          lot.remaining = r2(Number(lot.remaining) - take);
          pushMov(d, { date: c.date, item_id: ln.item_id, item_name: ln.item_name, unit: ln.unit, type: 'تسوية جرد', qty: -take, warehouse_from: c.warehouse_name, warehouse_to: '', lot_id: lot.id, lot_no: lot.lot_no, expiry: lot.expiry || '', source: { kind: 'جرد', num: c.num }, user: ctx.user, note: c.note });
        }
      } else {
        const nid = d.seq.lot++;
        const nlot = {
          id: nid, lot_no: System.formatNum('adjlot', { year: new Date().getFullYear(), n: d.seq.lot_num++ }),
          item_id: ln.item_id, item_name: ln.item_name, unit: ln.unit,
          qty: diff, remaining: diff, cost_per_unit: Number(it.last_price || 0),
          warehouse_id: c.warehouse_id, warehouse_name: c.warehouse_name,
          expiry: '', qc: 'مقبولة', qc_final: 'مقبولة', order_num: '', date: c.date, backfilled: true, created_at: now()
        };
        d.lots.push(nlot);
        pushMov(d, { date: c.date, item_id: ln.item_id, item_name: ln.item_name, unit: ln.unit, type: 'تسوية جرد', qty: diff, warehouse_from: '', warehouse_to: c.warehouse_name, lot_id: nid, lot_no: nlot.lot_no, expiry: '', source: { kind: 'جرد', num: c.num }, user: ctx.user, note: c.note });
      }
    }
    c.status = 'معتمدة'; c.approved_by = ctx.user; c.approved_at = now();
    db.save(d);
    return { data: c };
  },

  // ---- التلف ----
  listWastes() {
    const d = load();
    return { data: d.wastes.slice().sort((a, b) => (a.id < b.id ? 1 : -1)) };
  },
  addWaste(b, ctx) {
    if (!Auth.can(ctx.role, 'inventory', 'move')) err('التلف: أمين المخزن أو المدير فقط', 403);
    const md = mdata();
    const it = getItem(md, b.item_id);
    const wh = getWh(md, b.warehouse_id);
    const qty = toNum(b.qty, 'الكمية');
    if (!(qty > 0)) err('الكمية أكبر من صفر');
    if (!WASTE_REASONS.includes(b.reason)) err('السبب: ' + WASTE_REASONS.join(' / '));
    const d = load(); backfill(d);
    const row = {
      id: d.seq.waste++, date: validDate(b.date || now().slice(0, 10), 'التاريخ'),
      item_id: it.id, item_name: it.name, unit: it.unit,
      warehouse_id: wh.id, warehouse_name: wh.name, qty: r2(qty),
      reason: b.reason, ref: String(b.ref || '').trim(), status: 'مسودة', by: ctx.user, created_at: now()
    };
    d.wastes.push(row);
    db.save(d);
    return { data: row };
  },
  updateWaste(id, b, ctx) {
    if (!Auth.can(ctx.role, 'inventory', 'move')) err('التلف: أمين المخزن أو المدير فقط', 403);
    const md = mdata();
    const d = load();
    const r = d.wastes.find(x => x.id === Number(id));
    if (!r) err('غير موجود', 404);
    if (r.status !== 'مسودة') err('التعديل قبل التأكيد فقط');
    if (b.item_id !== undefined) { const it = getItem(md, b.item_id); r.item_id = it.id; r.item_name = it.name; r.unit = it.unit; }
    if (b.warehouse_id !== undefined) { const wh = getWh(md, b.warehouse_id); r.warehouse_id = wh.id; r.warehouse_name = wh.name; }
    if (b.qty !== undefined) { const q = toNum(b.qty, 'الكمية'); if (!(q > 0)) err('الكمية أكبر من صفر'); r.qty = r2(q); }
    if (b.reason !== undefined) {
      if (!WASTE_REASONS.includes(b.reason)) err('السبب: ' + WASTE_REASONS.join(' / '));
      r.reason = b.reason;
    }
    if (b.ref !== undefined) r.ref = String(b.ref || '').trim();
    if (b.date !== undefined) r.date = validDate(b.date, 'التاريخ');
    db.save(d);
    return { data: r };
  },
  confirmWaste(id, ctx) {
    if (!Auth.can(ctx.role, 'inventory', 'move')) err('التلف: أمين المخزن أو المدير فقط', 403);
    const d = load();
    const r = d.wastes.find(x => x.id === Number(id));
    if (!r) err('غير موجود', 404);
    if (r.status !== 'مسودة') err('تم تأكيده مسبقاً');
    const takes = allocate(d, r.item_id, r.warehouse_id, r.qty, r.item_name);
    for (const { lot, take } of takes) {
      lot.remaining = r2(Number(lot.remaining) - take);
      pushMov(d, { date: r.date, item_id: r.item_id, item_name: r.item_name, unit: r.unit, type: 'تلف', qty: -take, warehouse_from: r.warehouse_name, warehouse_to: '', lot_id: lot.id, lot_no: lot.lot_no, expiry: lot.expiry || '', source: { kind: 'تلف', num: 'W-' + r.id }, user: ctx.user, note: r.reason + (r.ref ? ' — ' + r.ref : '') });
    }
    r.status = 'مؤكدة'; r.confirmed_by = ctx.user; r.confirmed_at = now();
    db.save(d);
    return { data: r };
  }
};

module.exports = Inv;

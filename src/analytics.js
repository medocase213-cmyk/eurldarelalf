// التحليلات: قراءة فقط وتجميع زمني — بلا أي كتابة وبلا مساس بالمنطق القائم
// القاعدة: نفس قواعد Finance.pnl والمقاييس المعتمدة في Dashboard (مصدر واحد لكل مؤشر)
const Finance = require('./finance');
const Inv = require('./inventory');
const Auth = require('./auth');
const jstore = require('./jstore');

const r2 = n => Math.round(Number(n || 0) * 100) / 100;
function err(msg, code) { throw Object.assign(new Error(msg), { code: code || 400 }); }
function need(ctx, sec) {
  if (!ctx || ctx.role === 'guest') throw Object.assign(new Error('سجل الدخول أولاً'), { code: 401 });
  if (!Auth.can(ctx.role, sec, 'view')) throw Object.assign(new Error('غير مصرح لك بهذا التحليل'), { code: 403 });
}
const DRE = /^\d{4}-\d{2}-\d{2}$/;
function todayStr() { return new Date().toISOString().slice(0, 10); }
function addDays(ds, n) {
  const d = new Date(String(ds) + 'T00:00:00Z');
  if (isNaN(d)) return '';
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(ds) {
  const d = new Date(String(ds) + 'T00:00:00Z');
  const k = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - k);
  return d.toISOString().slice(0, 10);
}
// النطاق: from/to صريحان أو days (7/30/90/180/365) — ينتهي اليوم
function range(q) {
  let to = String((q && q.get('to')) || todayStr());
  let from = String((q && q.get('from')) || '');
  if (!DRE.test(to)) err('تاريخ النهاية غير صالح (YYYY-MM-DD)');
  if (!from) {
    const days = Math.max(1, Math.min(730, Number((q && q.get('days')) || 30) || 30));
    from = addDays(to, -(days - 1));
  }
  if (!DRE.test(from)) err('تاريخ البداية غير صالح (YYYY-MM-DD)');
  if (from > to) err('البداية بعد النهاية');
  return { from, to };
}
function spanDays(from, to) { return Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1; }
// الحاويات: day/week/month/auto — كل حاوية {key,label,from,to,i}
function buckets(from, to, mode) {
  let m = String(mode || 'auto');
  if (m === 'auto') { const s = spanDays(from, to); m = s <= 31 ? 'day' : s <= 124 ? 'week' : 'month'; }
  if (!['day', 'week', 'month'].includes(m)) err('التجميع: day أو week أو month');
  const out = [];
  if (m === 'day') {
    for (let d = from, i = 0; d <= to; d = addDays(d, 1), i++) {
      const p = d.split('-');
      out.push({ key: d, label: p[2] + '/' + p[1], from: d, to: d, i });
    }
  } else if (m === 'week') {
    let s = mondayOf(from);
    let i = 0;
    while (s <= to) {
      const e = addDays(s, 6) > to ? to : addDays(s, 6);
      const p = s.split('-');
      out.push({ key: s, label: 'أسبوع ' + p[2] + '/' + p[1], from: s > from ? s : from, to: e, i: i++ });
      s = addDays(s, 7);
    }
  } else {
    let cur = from.slice(0, 7);
    const end = to.slice(0, 7);
    let i = 0;
    while (cur <= end) {
      const ms = cur + '-01';
      const nx = new Date(cur + '-01T00:00:00Z'); nx.setUTCMonth(nx.getUTCMonth() + 1);
      const me = addDays(nx.toISOString().slice(0, 10), -1);
      out.push({ key: cur, label: cur, from: ms < from ? from : ms, to: me > to ? to : me, i: i++ });
      cur = nx.toISOString().slice(0, 7);
    }
  }
  return { list: out, mode: m };
}
function fill(list, fn) { return list.map(b => Object.assign({ key: b.key, label: b.label }, fn(b))); }
function hasAny(rows) { return (rows || []).length > 0; }
function pct(a, b) {
  if (!(Number(b) > 0) && !(Number(b) < 0)) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(((Number(a) - Number(b)) / Math.abs(Number(b))) * 1000) / 10;
}
const toTons = (qty, unit) => {
  const q = Number(qty || 0);
  if (!(q > 0)) return 0;
  if (unit === 'طن') return q;
  if (unit === 'قنطار') return q / 10;
  if (unit === 'كغ') return q / 1000;
  return 0;
};
function master() {
  try { return jstore('master.json', { items: [], categories: [], suppliers: [], customers: [], warehouses: [] }).load(); }
  catch { return { items: [], categories: [], suppliers: [], customers: [], warehouses: [] }; }
}
function finType(whId, md) {
  const w = (md.warehouses || []).find(x => x.id === Number(whId));
  return w ? w.type : '';
}
// صافي النطاق بنفس قواعد Finance.pnl تماماً (إيرادات − تكلفة البضاعة − مصاريف) — مصدر واحد للربحية
function pnlRange(sd, fd, a, b) {
  let revenue = 0, cogs = 0;
  for (const o of sd.invoices || []) {
    const ds = String(o.date || '').slice(0, 10);
    if (o.status !== 'مؤكدة' || ds < a || ds > b) continue;
    revenue = r2(revenue + Number(o.total || 0));
    for (const l of o.lines || []) cogs = r2(cogs + Number(l.qty || 0) * Number(l.cost_snapshot || 0));
  }
  for (const rt of sd.returns || []) {
    const ds = String(rt.date || '').slice(0, 10);
    if (ds < a || ds > b) continue;
    const inv = (sd.invoices || []).find(o => o.id === rt.invoice_id);
    for (const l of rt.lines || []) {
      const ol = inv ? (inv.lines || []).find(x => x.item_id === l.item_id) : null;
      revenue = r2(revenue - Number(l.qty || 0) * Number(ol ? ol.price : 0));
      cogs = r2(cogs - Number(l.qty || 0) * Number(ol && ol.cost_snapshot != null ? ol.cost_snapshot : 0));
    }
  }
  for (const x of fd.incomes || []) {
    const ds = String(x.date || '').slice(0, 10);
    if (ds >= a && ds <= b) revenue = r2(revenue + Number(x.amount || 0));
  }
  let expenses = 0;
  for (const x of fd.expenses || []) {
    const ds = String(x.date || '').slice(0, 10);
    if (ds >= a && ds <= b) expenses = r2(expenses + Number(x.amount || 0));
  }
  return { revenue, cogs, expenses, net: r2(revenue - cogs - expenses) };
}

const Analytics = {
  // بيانات الفلاتر + أعلام الصلاحيات (تُبنى من Master والطلبات الحقيقية)
  meta(ctx) {
    need(ctx, 'reports');
    const md = master();
    const cats = {};
    for (const c of md.categories || []) cats[c.id] = c.main;
    const raw = (md.items || []).filter(i => cats[i.category_id] !== 'منتج نهائي').map(i => ({ id: i.id, name: i.name }));
    const fin = (md.items || []).filter(i => cats[i.category_id] === 'منتج نهائي').map(i => ({ id: i.id, name: i.name }));
    let products = fin.map(i => i.name);
    try {
      const pd = jstore('production.json', { orders: [] }).load();
      for (const o of pd.orders || []) if (o.product_name && !products.includes(o.product_name)) products.push(o.product_name);
    } catch {}
    return {
      data: {
        products, materials: raw,
        warehouses: (md.warehouses || []).map(w => ({ id: w.id, name: w.name, type: w.type })),
        suppliers: (md.suppliers || []).map(s => ({ id: s.id, name: s.name })),
        customers: (md.customers || []).map(c => ({ id: c.id, name: c.name })),
        prodStatuses: ['مسودة', 'قيد التنفيذ', 'مكتملة', 'ملغاة'],
        flags: {
          money: Auth.can(ctx.role, 'finance', 'account'), // نفس قاعدة Dashboard (showMoney)
          stock: Auth.can(ctx.role, 'inventory', 'view'),
          production: Auth.can(ctx.role, 'production', 'view'),
          sales: Auth.can(ctx.role, 'sales', 'view'),
          procurement: Auth.can(ctx.role, 'procurement', 'view')
        }
      }
    };
  },

  // منحنى الإنتاج: أوامر مكتملة (closed_at ثم date) — بلا مستهدف (غير موجود في النظام)
  production(q, ctx) {
    need(ctx, 'production');
    const { from, to } = range(q);
    const { list, mode } = buckets(from, to, q && q.get('bucket'));
    const product = String((q && q.get('product')) || '').trim();
    const pd = jstore('production.json', { orders: [] }).load();
    const rows = (pd.orders || []).filter(o => o.status === 'مكتملة'
      && String(o.closed_at || o.date || '').slice(0, 10) >= from
      && String(o.closed_at || o.date || '').slice(0, 10) <= to
      && (!product || o.product_name === product));
    const data = fill(list, b => {
      const r = rows.filter(o => { const d = String(o.closed_at || o.date || '').slice(0, 10); return d >= b.from && d <= b.to; });
      return {
        qty: r2(r.reduce((s, o) => s + Number(o.actual_qty || 0), 0)),
        waste: r2(r.reduce((s, o) => s + Number(o.waste || 0), 0)),
        orders: r.length
      };
    });
    return { data: { from, to, mode, unit: 'قنطار', target: null, targetNote: 'لا يوجد هدف إنتاج مسجل في النظام — يُعرض الفعلي فقط', hasData: hasAny(rows), buckets: data } };
  },

  // منحنى المبيعات: فواتير مؤكدة + مقارنة الفترة السابقة
  sales(q, ctx) {
    need(ctx, 'sales');
    const { from, to } = range(q);
    const { list, mode } = buckets(from, to, q && q.get('bucket'));
    const customer = String((q && q.get('customer')) || '');
    const sd = jstore('sales.json', { invoices: [], receipts: [] }).load();
    const rows = (sd.invoices || []).filter(o => o.status === 'مؤكدة'
      && String(o.date || '') >= from && String(o.date || '') <= to
      && (!customer || String(o.customer_id) === customer));
    const data = fill(list, b => {
      const r = rows.filter(o => String(o.date || '') >= b.from && String(o.date || '') <= b.to);
      return { revenue: r2(r.reduce((s, o) => s + Number(o.total || 0), 0)), count: r.length };
    });
    const n = spanDays(from, to);
    const pTo = addDays(from, -1), pFrom = addDays(from, -n);
    const prev = (sd.invoices || []).filter(o => o.status === 'مؤكدة' && String(o.date || '') >= pFrom && String(o.date || '') <= pTo
      && (!customer || String(o.customer_id) === customer));
    const total = r2(data.reduce((s, b) => s + b.revenue, 0));
    const prevTotal = r2(prev.reduce((s, o) => s + Number(o.total || 0), 0));
    return { data: { from, to, mode, hasData: hasAny(rows), buckets: data, total, prevTotal, prevChange: pct(total, prevTotal), prevRange: { from: pFrom, to: pTo } } };
  },

  // المخزون: اللقطة الحالية + تدفق الحركات (دخول/خروج) — لا لقطات تاريخية في النظام
  inventory(q, ctx) {
    need(ctx, 'inventory');
    const { from, to } = range(q);
    const { list, mode } = buckets(from, to, q && q.get('bucket'));
    const md = master();
    const wh = String((q && q.get('warehouse')) || '');
    const item = String((q && q.get('item')) || '');
    const bal = Inv.balance().data.filter(r => (!wh || String(r.warehouse_id) === wh) && (!item || String(r.item_id) === item));
    let rawQty = 0, finQty = 0, rawVal = 0, finVal = 0;
    for (const r of bal) {
      if (finType(r.warehouse_id, md) === 'منتج نهائي') { finQty = r2(finQty + Number(r.qty || 0)); finVal = r2(finVal + Number(r.value || 0)); }
      else { rawQty = r2(rawQty + Number(r.qty || 0)); rawVal = r2(rawVal + Number(r.value || 0)); }
    }
    const d = jstore('inventory.json', { movements: [] }).load();
    const movs = (d.movements || []).filter(mv => String(mv.date || '') >= from && String(mv.date || '') <= to
      && (!item || String(mv.item_id) === item)
      && (!wh || String(mv.warehouse_to) === wh || String(mv.warehouse_from) === wh));
    const isIn = mv => mv.type === 'دخول' || (mv.type === 'تسوية جرد' && Number(mv.qty || 0) > 0);
    const isOut = mv => mv.type === 'خروج' || mv.type === 'تلف' || (mv.type === 'تسوية جرد' && Number(mv.qty || 0) < 0);
    const data = fill(list, b => {
      const r = movs.filter(mv => String(mv.date || '') >= b.from && String(mv.date || '') <= b.to);
      let inn = 0, out = 0;
      for (const mv of r) {
        const qq = Math.abs(Number(mv.qty || 0));
        if (isIn(mv)) inn = r2(inn + qq);
        else if (isOut(mv)) out = r2(out + qq);
      }
      return { in: inn, out: out };
    });
    return {
      data: {
        from, to, mode, hasData: hasAny(movs),
        snapshot: { rawQty, finQty, rawVal, finVal, totalVal: r2(rawVal + finVal) },
        flowNote: 'التدفق من حركات النظام (دخول/خروج/تلف/تسوية) — التحويلات الداخلية محايدة. اللقطة بتاريخ اليوم.',
        buckets: data
      }
    };
  },

  // الربحية: نفس قواعد Finance.pnl (إيرادات − تكلفة البضاعة − مصاريف) — تطابق Dashboard
  profit(q, ctx) {
    need(ctx, 'finance');
    const { from, to } = range(q);
    const { list, mode } = buckets(from, to, q && q.get('bucket'));
    const sd = jstore('sales.json', { invoices: [], returns: [], receipts: [] }).load();
    const fd = jstore('finance.json', { incomes: [], expenses: [] }).load();
    const calc = (a, b) => pnlRange(sd, fd, a < from ? from : a, b > to ? to : b);
    const data = fill(list, b => calc(b.from, b.to));
    const totals = calc(from, to);
    const anyDoc = (sd.invoices || []).concat(sd.returns || []).concat(fd.incomes || []).concat(fd.expenses || [])
      .some(x => { const ds = String(x.date || '').slice(0, 10); return ds >= from && ds <= to; });
    return { data: { from, to, mode, hasData: anyDoc, buckets: data, totals, rule: 'صافي الربح = الإيرادات − تكلفة البضاعة − المصاريف (نفس قاعدة لوحة القيادة)' } };
  },

  // تكلفة الإنتاج: متوسط مرجح لتكلفة اللوتات التامة حسب created_at — صراحة عند غياب البيانات
  cost(q, ctx) {
    need(ctx, 'finance');
    const { from, to } = range(q);
    const { list, mode } = buckets(from, to, q && q.get('bucket'));
    const md = master();
    const d = jstore('inventory.json', { lots: [] }).load();
    const rows = (d.lots || []).filter(l => finType(l.warehouse_id, md) === 'منتج نهائي'
      && Number(l.cost_per_unit || 0) > 0 && String(l.created_at || l.date || '').slice(0, 10) >= from && String(l.created_at || l.date || '').slice(0, 10) <= to);
    const avg = (rs) => {
      let v = 0, tn = 0;
      for (const l of rs) { const t = toTons(l.qty, l.unit); if (t > 0) { tn = r2(tn + t); v = r2(v + Number(l.qty || 0) * Number(l.cost_per_unit || 0)); } }
      return tn > 0 ? Math.round(v / tn) : null;
    };
    const data = fill(list, b => {
      const r = rows.filter(l => { const ds = String(l.created_at || l.date || '').slice(0, 10); return ds >= b.from && ds <= b.to; });
      return { costPerTon: avg(r), lots: r.length };
    });
    return {
      data: {
        from, to, mode, hasData: hasAny(rows), buckets: data, overall: avg(rows),
        insufficient: !hasAny(rows),
        message: hasAny(rows) ? '' : 'لا توجد بيانات كافية لحساب تكلفة الإنتاج بدقة'
      }
    };
  },

  // أسعار المواد الخام: سطور الطلبيات (سعر متفق + تاريخ) — بلا تقديرات
  prices(q, ctx) {
    need(ctx, 'procurement');
    const item = String((q && q.get('item_id')) || '');
    if (!item) err('اختر مادة خام (item_id)');
    const supplier = String((q && q.get('supplier')) || '');
    const { from, to } = range(q);
    const pd = jstore('procurement.json', { orders: [] }).load();
    const pts = [];
    for (const o of pd.orders || []) {
      const ds = String(o.date || '').slice(0, 10);
      if (ds < from || ds > to) continue;
      if (supplier && String(o.supplier_id) !== supplier) continue;
      for (const l of o.lines || []) {
        if (String(l.item_id) !== item) continue;
        pts.push({ date: ds, price: Number(l.price || 0), qty: Number(l.qty || 0), num: o.num, supplier: o.supplier_name || '' });
      }
    }
    pts.sort((a, b) => (a.date < b.date ? -1 : 1));
    const prices = pts.map(p => p.price).filter(v => v > 0);
    return {
      data: {
        from, to, hasData: pts.length > 0, points: pts,
        avg: prices.length ? r2(prices.reduce((s, v) => s + v, 0) / prices.length) : null,
        min: prices.length ? Math.min(...prices) : null,
        max: prices.length ? Math.max(...prices) : null,
        sourceNote: 'أسعار سطور الطلبيات (المتفق عليها بتاريخ الطلبية)'
      }
    };
  },

  // المقارنة: الفترة الحالية مقابل السابقة المساوية + إنتاج/مبيعات + إيرادات/مصاريف
  compare(q, ctx) {
    need(ctx, 'reports');
    const { from, to } = range(q);
    const n = spanDays(from, to);
    const pTo = addDays(from, -1), pFrom = addDays(from, -n);
    const money = Auth.can(ctx.role, 'finance', 'view');
    const pd = jstore('production.json', { orders: [] }).load();
    const sd = jstore('sales.json', { invoices: [] }).load();
    const sumProd = (a, b) => r2((pd.orders || []).filter(o => o.status === 'مكتملة' && String(o.closed_at || o.date || '').slice(0, 10) >= a && String(o.closed_at || o.date || '').slice(0, 10) <= b).reduce((s, o) => s + Number(o.actual_qty || 0), 0));
    const sumSales = (a, b) => r2((sd.invoices || []).filter(o => o.status === 'مؤكدة' && String(o.date || '') >= a && String(o.date || '') <= b).reduce((s, o) => s + Number(o.total || 0), 0));
    const cur = { production: sumProd(from, to), sales: sumSales(from, to) };
    const prev = { production: sumProd(pFrom, pTo), sales: sumSales(pFrom, pTo) };
    let fin = null;
    if (money) {
      const sd2 = jstore('sales.json', { invoices: [], returns: [], receipts: [] }).load();
      const fd2 = jstore('finance.json', { incomes: [], expenses: [] }).load();
      const c = pnlRange(sd2, fd2, from, to), p = pnlRange(sd2, fd2, pFrom, pTo);
      fin = { revenue: { cur: c.revenue, prev: p.revenue, ch: pct(c.revenue, p.revenue) }, expenses: { cur: c.expenses, prev: p.expenses, ch: pct(c.expenses, p.expenses) }, net: { cur: c.net, prev: p.net, ch: pct(c.net, p.net) } };
    }
    // تكلفة الطن: الحالية مقابل السابقة (تحتاج صلاحية مالية أو إنتاج)
    let cost = null;
    if (money || Auth.can(ctx.role, 'production', 'view')) {
      try {
        const md = master();
        const d = jstore('inventory.json', { lots: [] }).load();
        const avg = (a, b) => {
          let v = 0, tn = 0;
          for (const l of d.lots || []) {
            if (finType(l.warehouse_id, md) !== 'منتج نهائي' || !(Number(l.cost_per_unit || 0) > 0)) continue;
            const ds = String(l.created_at || l.date || '').slice(0, 10);
            if (ds < a || ds > b) continue;
            const t = toTons(l.qty, l.unit);
            if (t > 0) { tn = r2(tn + t); v = r2(v + Number(l.qty || 0) * Number(l.cost_per_unit || 0)); }
          }
          return tn > 0 ? Math.round(v / tn) : null;
        };
        const cc = avg(from, to), pp = avg(pFrom, pTo);
        cost = { cur: cc, prev: pp, ch: pct(cc, pp) };
      } catch { cost = null; }
    }
    return {
      data: {
        cur: { from, to }, prev: { from: pFrom, to: pTo },
        production: { cur: cur.production, prev: prev.production, ch: pct(cur.production, prev.production) },
        sales: { cur: cur.sales, prev: prev.sales, ch: pct(cur.sales, prev.sales) },
        finance: fin, cost
      }
    };
  },

  // طبيب المصنع (المرحلة 3): حكم آلي مسبب من 4 مؤشرات — قراءة فقط
  // الدرجة /100: ممتاز ≥80 / مستقر ≥60 / تحذير ≥40 / خطر <40 — القواعد معلنة في rule
  health(q, ctx) {
    need(ctx, 'finance');
    const t = todayStr().slice(0, 7);
    const cur = Finance.pnl(t).data;
    const cmp = Finance.compare().data;
    const dbt = Finance.debts().data;
    const kpi = Finance.kpi(t).data;
    // 1) هامش الصافي الشهري (25 نقطة)
    const marginPct = cur.revenue > 0 ? Math.round(cur.net / cur.revenue * 1000) / 10 : (cur.net < 0 ? -100 : 0);
    const marginScore = marginPct >= 20 ? 25 : marginPct >= 10 ? 20 : marginPct >= 0 ? 12 : marginPct > -10 ? 5 : 0;
    // 2) الاتجاه: متوسط صافي آخر 3 أشهر مقابل الثلاثة السابقة (25 نقطة)
    const nets = cmp.map(m => Number(m.net || 0));
    const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    const last3 = avg(nets.slice(-3)), prev3 = avg(nets.slice(0, 3));
    const activeMonths = cmp.filter(m => Number(m.revenue || 0) > 0 || Number(m.net || 0) !== 0).length;
    let trendScore = 12, trendLabel = 'بيانات حديثة — يُبنى الاتجاه مع الشهور';
    if (activeMonths >= 2) {
      if (last3 > prev3 && last3 > 0) { trendScore = 25; trendLabel = 'تحسن رابح'; }
      else if (last3 >= prev3 && last3 >= 0) { trendScore = 20; trendLabel = 'مستقر رابح'; }
      else if (last3 > prev3) { trendScore = 12; trendLabel = 'يتعافى من خسارة'; }
      else if (last3 >= 0) { trendScore = 5; trendLabel = 'تباطؤ (ربح متناقص)'; }
      else { trendScore = 0; trendLabel = 'تدهور'; }
    }
    // 3) السيولة: نقد + لنا − علينا (25 نقطة)
    const rec = r2((dbt.customers || []).reduce((s, x) => s + Math.max(0, Number(x.net || 0)), 0));
    const pay = r2((dbt.suppliers || []).reduce((s, x) => s + Math.max(0, Number(x.net || 0)), 0));
    const cash = Number(kpi.cash || 0);
    const liq = r2(cash + rec - pay);
    const liqScore = (liq >= 0 && cash > 0) ? 25 : liq >= 0 ? 18 : cash > 0 ? 10 : 0;
    // 4) الركود: قيمة اللوتات المتبقية الأقدم من 60 يوماً (25 نقطة)
    const bal = Inv.balance().data;
    const stockVal = r2(bal.reduce((s, r) => s + Number(r.value || 0), 0));
    const invD = jstore('inventory.json', { lots: [] }).load();
    const cut = addDays(todayStr(), -60);
    let stagVal = 0;
    for (const l of invD.lots || []) {
      if (!(Number(l.remaining || 0) > 0)) continue;
      const ds = String(l.date || l.created_at || '').slice(0, 10);
      if (ds && ds < cut) stagVal = r2(stagVal + Number(l.remaining || 0) * Number(l.cost_per_unit || 0));
    }
    const stagShare = stockVal > 0 ? Math.round(stagVal / stockVal * 1000) / 10 : 0;
    const stockScore = stagShare < 10 ? 25 : stagShare < 25 ? 15 : 5;
    const score = marginScore + trendScore + liqScore + stockScore;
    let VT = { vExcellent: 80, vStable: 60, vWarn: 40 };
    try {
      const sys = require('./system').tracking();
      VT = { vExcellent: sys.vExcellent, vStable: sys.vStable, vWarn: sys.vWarn };
    } catch {}
    const verdict = score >= VT.vExcellent ? 'ممتاز' : score >= VT.vStable ? 'مستقر' : score >= VT.vWarn ? 'تحذير' : 'خطر';
    // التوصيات (حتى 5 مرتبة بالأثر = المبلغ)
    const recs = [];
    const topCust = (dbt.customers || []).filter(x => Number(x.net || 0) > 0).sort((a, b) => Number(b.net) - Number(a.net))[0];
    if (topCust) recs.push({ amount: r2(Number(topCust.net)), text: 'حصّل دين ' + topCust.name + ' (' + r2(Number(topCust.net)) + ' دج) ← سيولة مباشرة' });
    const sd = jstore('sales.json', { invoices: [] }).load();
    const pm = {};
    for (const o of sd.invoices || []) {
      if (o.status !== 'مؤكدة' || !String(o.date || '').startsWith(t)) continue;
      for (const l of o.lines || []) {
        pm[l.item_id] = pm[l.item_id] || { name: l.item_name, revenue: 0, cost: 0 };
        pm[l.item_id].revenue = r2(pm[l.item_id].revenue + Number(l.qty || 0) * Number(l.price || 0));
        pm[l.item_id].cost = r2(pm[l.item_id].cost + Number(l.qty || 0) * Number(l.cost_snapshot || 0));
      }
    }
    // مرتجعات الشهر تُخصم من المنتج (إيراداً وتكلفة) — كالمالية
    for (const rt of (sd.returns || [])) {
      if (!String(rt.date || '').startsWith(t)) continue;
      const inv = (sd.invoices || []).find(x => x.id === Number(rt.invoice_id));
      if (!inv || inv.status !== 'مؤكدة') continue;
      for (const l of rt.lines || []) {
        const ol = (inv.lines || []).find(x => Number(x.item_id) === Number(l.item_id));
        if (!pm[l.item_id]) pm[l.item_id] = { name: l.item_name, revenue: 0, cost: 0 };
        pm[l.item_id].revenue = r2(pm[l.item_id].revenue - Number(l.qty || 0) * Number(ol ? ol.price : 0));
        pm[l.item_id].cost = r2(pm[l.item_id].cost - Number(l.qty || 0) * Number(ol && ol.cost_snapshot != null ? ol.cost_snapshot : 0));
      }
    }
    const negs = Object.values(pm)
      .map(p => ({ ...p, profit: r2(p.revenue - p.cost), margin: p.revenue > 0 ? Math.round((p.revenue - p.cost) / p.revenue * 1000) / 10 : 0 }))
      .filter(p => p.profit < 0).sort((a, b) => a.profit - b.profit);
    if (negs.length) recs.push({ amount: r2(-negs[0].profit), text: 'هامش ' + negs[0].name + ' سالب ' + negs[0].margin + '% (خسارة ' + r2(-negs[0].profit) + ' دج) ← ارفع سعره أو راجع تركيبته' });
    const cats = Object.entries(cur.byCat || {}).sort((a, b) => b[1] - a[1]);
    if (cats.length && cats[0][1] > 0) recs.push({ amount: r2(cats[0][1]), text: 'مصاريف «' + cats[0][0] + '» هي الأعلى (' + r2(cats[0][1]) + ' دج) ← راجع بنودها' });
    if (stagVal > 0) recs.push({ amount: stagVal, text: 'مخزون راكد بقيمة ' + stagVal + ' دج (أقدم من 60 يوم) ← حرّكه بعروض قبل انتهائه' });
    const topSup = (dbt.suppliers || []).filter(x => Number(x.net || 0) > 0).sort((a, b) => Number(b.net) - Number(a.net))[0];
    if (topSup) recs.push({ amount: r2(Number(topSup.net)), text: 'ديون علينا لـ ' + topSup.name + ' (' + r2(Number(topSup.net)) + ' دج) ← جدول سدادها' });
    recs.sort((a, b) => b.amount - a.amount);
    return {
      data: {
        month: t, verdict, score,
        rule: 'الدرجة /100 = هامش الشهر (25) + الاتجاه 3 أشهر (25) + السيولة (25) + الركود (25) — ممتاز ≥' + VT.vExcellent + ' / مستقر ≥' + VT.vStable + ' / تحذير ≥' + VT.vWarn + ' / خطر <' + VT.vWarn,
        indicators: {
          marginPct, marginNet: cur.net, marginRevenue: cur.revenue,
          trend: trendLabel, trendLast3: r2(last3), trendPrev3: r2(prev3),
          cash, receivables: rec, payables: pay, liquidity: liq,
          stockValue: stockVal, stagnantValue: stagVal, stagnantShare: stagShare
        },
        causes: [
          { label: 'هامش صافي الشهر', value: marginPct + '% (صافي ' + cur.net + ' من إيراد ' + cur.revenue + ')' },
          { label: 'الاتجاه', value: trendLabel + ' (آخر 3 أشهر ' + r2(last3) + ' مقابل السابقة ' + r2(prev3) + ')' },
          { label: 'السيولة', value: 'نقد ' + cash + ' + لنا ' + rec + ' − علينا ' + pay + ' = ' + liq },
          { label: 'الركود', value: stagVal + ' دج (' + stagShare + '% من المخزون) أقدم من 60 يوم' }
        ],
        recommendations: recs.slice(0, 5).map(r => r.text),
        generated_at: todayStr()
      }
    };
  }
};

module.exports = Analytics;

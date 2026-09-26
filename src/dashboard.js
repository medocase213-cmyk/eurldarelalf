// لوحة القيادة: مجمّع قراءة فقط من كل الأقسام — بلا جداول خاصة
const Finance = require('./finance');
const Inv = require('./inventory');
const Prod = require('./production');
const Sales = require('./sales');
const Auth = require('./auth');
const jstore = require('./jstore');

const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const OVERDUE_DAYS = 30;
function ageDays(dateStr, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  return Math.round((Date.parse(today) - Date.parse(dateStr)) / 86400000);
}
function plusDays(dateStr, n) {
  const d = new Date(String(dateStr || '') + 'T00:00:00Z');
  if (isNaN(d)) return '';
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const Dash = {
  full(ctx) {
    const t = new Date().toISOString().slice(0, 10);
    const month = t.slice(0, 7);
    // حجب المالية: الأرقام والتنبيهات المالية لغير أصحاب finance.view فقط (لا يكفي إخفاء الواجهة)
    const canMoney = Auth.can((ctx && ctx.role) || 'guest', 'finance', 'view');
    const fk = canMoney ? Finance.kpi(month).data : { cash: 0, net: 0, payables: 0, receivables: 0 };
    const debts = canMoney ? Finance.debts().data : { suppliers: [], customers: [] };
    const bal = Inv.balance().data;
    const lots = Inv.lots().data;
    const pk = Prod.kpi().data;
    const sk = Sales.kpi().data;
    // التدفق النقدي: صافي آخر 3 أشهر من المقارنة (مالي — محجوب بلا صلاحية)
    const cmp = canMoney ? Finance.compare().data : [];
    const md = require('./store').load();
    const whType = {};
    for (const w of md.warehouses || []) whType[w.id] = w.type;
    let stockRaw = 0, stockFin = 0;
    for (const r of bal) {
      if (whType[r.warehouse_id] === 'منتج نهائي') stockFin = r2(stockFin + Number(r.value || 0));
      else stockRaw = r2(stockRaw + Number(r.value || 0));
    }
    // التنبيهات: أحمر أولاً ثم أصفر
    const reds = [], yellows = [];
    for (const l of lots) {
      if (!(Number(l.remaining || 0) > 0)) continue;
      if (l.days_left !== null && l.days_left !== undefined && l.days_left < 0) {
        reds.push({ level: 'red', text: 'دفعة منتهية: ' + l.lot_no + ' (' + l.item_name + ')', section: 'lots' });
      } else if (l.qc_final === 'مرفوضة') {
        yellows.push({ level: 'yellow', text: 'دفعة مرفوضة محجوبة: ' + l.lot_no, section: 'lots' });
      } else if (l.days_left !== null && l.days_left !== undefined && l.days_left <= 60) {
        yellows.push({ level: 'yellow', text: 'قرب انتهاء ' + l.lot_no + ' (' + l.days_left + ' يوم)', section: 'lots' });
      }
    }
    for (const r of bal) {
      if (r.status === 'low') reds.push({ level: 'red', text: 'تحت الحد: ' + r.item_name + ' (' + r.warehouse_name + ')', section: 'inventory' });
      else if (r.status === 'near') yellows.push({ level: 'yellow', text: 'قرب الحد: ' + r.item_name, section: 'inventory' });
    }
    // منتج تام في مخزن خام: يُحتسب في الرصيد لكنه غير قابل للبيع — يُنقل لمخزن التام
    try {
      const wtype = {};
      for (const w of md.warehouses || []) wtype[w.id] = w.type;
      const cats = {};
      for (const c of md.categories || []) cats[c.id] = c.main;
      const misQty = {};
      const misName = {}, misWh = {};
      for (const l of lots) {
        if (!(Number(l.remaining || 0) > 0)) continue;
        if (wtype[l.warehouse_id] !== 'مواد أولية') continue;
        const it = (md.items || []).find(x => x.id === Number(l.item_id));
        if (!it || cats[Number(it.category_id)] !== 'منتج نهائي') continue;
        const k = Number(l.item_id);
        misQty[k] = r2((misQty[k] || 0) + Number(l.remaining || 0));
        misName[k] = l.item_name; misWh[k] = l.warehouse_name || '';
      }
      for (const k of Object.keys(misQty)) {
        yellows.push({ level: 'yellow', text: 'منتج تام في مخزن خام: ' + misName[k] + ' (' + misWh[k] + ' — ' + misQty[k] + ') — انقله لمخزن التام ليُباع', section: 'inventory' });
      }
    } catch {}
    for (const s of debts.suppliers || []) {
      if (!canMoney) break;
      if (s.net > 0) {
        const old = (require('./jstore')('finance.json', { payables: [] }).load().payables || [])
          .filter(p => p.supplier_id === s.id && Number(p.amount || 0) > 0 && ageDays(p.date, t) !== null && ageDays(p.date, t) > OVERDUE_DAYS);
        if (old.length) reds.push({ level: 'red', text: 'دين متأخر لـ ' + s.name + ': ' + old.length + ' مستحق', section: 'finance' });
      }
    }
    for (const c of debts.customers || []) {
      if (!canMoney) break;
      // سقف الدين المحدد في بطاقة الزبون: التجاوز = تنبيه أحمر (يحمي المصنع من الديون المتراكمة)
      try {
        const cust = (md.customers || []).find(x => Number(x.id) === Number(c.id));
        const lim = cust ? Number(cust.debt_limit || 0) : 0;
        if (lim > 0 && Number(c.net || 0) > lim) {
          reds.push({ level: 'red', text: 'تجاوز سقف الدين: ' + c.name + ' (الدين ' + r2(c.net) + ' > الحد ' + r2(lim) + ')', section: 'sales' });
        }
      } catch {}
      if (c.net > 0) {
        const sd = require('./jstore')('sales.json', { invoices: [] }).load();
        const old = (sd.invoices || []).filter(o => o.customer_id === c.id && o.status === 'مؤكدة' && ageDays(o.date, t) !== null && ageDays(o.date, t) > OVERDUE_DAYS);
        if (old.length) reds.push({ level: 'red', text: 'دين متأخر على ' + c.name + ': ' + old.length + ' فاتورة', section: 'finance' });
      }
    }
    // تنبيهات الخمول (المرحلة 2): آخر نشاط = آخر فاتورة مؤكدة أو طلبية — الأصفر عند المهلة والأحمر عند ضعفها
    // الزبون بلا أي نشاط سابق يُعفى (لا أساس للقياس) — والطلبية النائمة (مسودة/موثقة قديمة) تنبيه بحد ذاتها
    try {
      const sdc = require('./jstore')('sales.json', { invoices: [], cmdorders: [] }).load();
      const lastAct = {};
      for (const o of (sdc.invoices || [])) {
        if (o.status !== 'مؤكدة') continue;
        const cid = Number(o.customer_id);
        const ds = String(o.date || '');
        if (ds && (!lastAct[cid] || ds > lastAct[cid])) lastAct[cid] = ds;
      }
      for (const o of (sdc.cmdorders || [])) {
        const cid = Number(o.customer_id);
        const ds = String(o.date || '');
        if (ds && (!lastAct[cid] || ds > lastAct[cid])) lastAct[cid] = ds;
      }
      let idleDef = 7;
      try { idleDef = require('./system').tracking().defaultIdleDays; } catch {}
      for (const c of (md.customers || [])) {
        if (c.active === false) continue;
        const last = lastAct[Number(c.id)];
        if (!last) continue;
        const days = ageDays(last, t);
        if (days === null) continue;
        const lim = Number(c.idle_days) > 0 ? Number(c.idle_days) : idleDef;
        if (days > lim * 2) reds.push({ level: 'red', text: 'زبون خامل: ' + c.name + ' (آخر نشاط منذ ' + days + ' يوم)', section: 'sales' });
        else if (days > lim) yellows.push({ level: 'yellow', text: 'خمول يقترب: ' + c.name + ' (آخر نشاط منذ ' + days + ' يوم — المهلة ' + lim + ')', section: 'sales' });
      }
      for (const o of (sdc.cmdorders || [])) {
        if (o.status !== 'مسودة' && o.status !== 'موثقة') continue;
        const cust = (md.customers || []).find(x => Number(x.id) === Number(o.customer_id));
        const lim = cust && Number(cust.idle_days) > 0 ? Number(cust.idle_days) : idleDef;
        const days = ageDays(String(o.date || ''), t);
        if (days !== null && days > lim) yellows.push({ level: 'yellow', text: 'طلبية نائمة: ' + o.num + ' (' + (o.customer_name || '') + ' — ' + o.status + ' منذ ' + days + ' يوم)', section: 'sales' });
      }
    } catch {}
    const pd = require('./jstore')('procurement.json', { orders: [] }).load();
    const pendAppr = pd.orders.filter(o => o.status === 'بانتظار الموافقة');
    const apprWait = pd.orders.filter(o => o.status === 'معتمدة');
    const partial = pd.orders.filter(o => o.status === 'مؤكدة جزئياً');
    for (const o of pendAppr) yellows.push({ level: 'yellow', text: 'طلبية بانتظار الموافقة: ' + o.num, section: 'procurement' });
    for (const o of partial) yellows.push({ level: 'yellow', text: 'طلبية جزئية مفتوحة: ' + o.num, section: 'procurement' });
    const accs = canMoney ? Finance.listAccounts().data : [];
    for (const a of accs) {
      if (Number(a.balance || 0) < 0) reds.push({ level: 'red', text: 'رصيد سالب: ' + a.name, section: 'finance' });
    }
    // حكم المصنع (المرحلة 3): خطر/تحذير يظهران هنا وفي الجرس تلقائياً
    try {
      if (canMoney) {
        const H = require('./analytics').health(null, ctx).data;
        if (H.verdict === 'خطر') reds.push({ level: 'red', text: 'حكم المصنع: خطر (درجة ' + H.score + ') — راجع التحليلات', section: 'analytics' });
        else if (H.verdict === 'تحذير') yellows.push({ level: 'yellow', text: 'حكم المصنع: تحذير (درجة ' + H.score + ')', section: 'analytics' });
      }
    } catch {}
    const alertsAll = [...reds, ...yellows];
    const alerts = alertsAll.slice(0, 15);
    // آخر الحركات المدمجة
    const rec = [];
    const sd = require('./jstore')('sales.json', { invoices: [], receipts: [] }).load();
    const prd = require('./jstore')('procurement.json', { deposits: [], confirmations: [] }).load();
    const pr = require('./jstore')('production.json', { orders: [] }).load();
    for (const o of sd.invoices || []) if (o.status === 'مؤكدة') rec.push({ at: o.date, kind: 'بيع', text: o.num + ' — ' + o.customer_name + ' — ' + o.total });
    for (const c of prd.confirmations || []) rec.push({ at: c.arrival_date, kind: 'شراء', text: c.order_num + ' — ' + c.supplier_name + ' — ' + c.received_total });
    for (const x of prd.deposits || []) rec.push({ at: x.date, kind: 'دفعة', text: x.order_num + ' — ' + x.method + ' — ' + x.amount });
    for (const x of sd.receipts || []) rec.push({ at: x.date, kind: 'تحصيل', text: x.invoice_num + ' — ' + x.amount });
    for (const o of pr.orders || []) if (o.status === 'مكتملة') rec.push({ at: String(o.closed_at || '').slice(0, 10), kind: 'إنتاج', text: o.num + ' — ' + o.product_name + ' — ' + o.actual_qty });
    rec.sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1));
    // الأكثر مبيعاً هذا الشهر
    const byProd = {};
    for (const o of sd.invoices || []) {
      if (o.status !== 'مؤكدة' || !String(o.date).startsWith(month)) continue;
      for (const l of o.lines || []) {
        byProd[l.item_name] = byProd[l.item_name] || { name: l.item_name, qty: 0 };
        byProd[l.item_name].qty = r2(byProd[l.item_name].qty + Number(l.qty || 0));
      }
    }
    const top = Object.values(byProd).sort((a, b) => b.qty - a.qty).slice(0, 5);
    // ---- توسعة إدارية (إضافة فقط — لا تمس alerts المشتركة مع الجرس) ----
    // الإنتاج: الحالات + اليوم + قيد التنفيذ + الهدر (مصادرها Prod.kpi وقائمة الأوامر)
    const prodOrders = pr.orders || [];
    const prodByStatus = {};
    for (const o of prodOrders) prodByStatus[o.status] = (prodByStatus[o.status] || 0) + 1;
    const stoppedProd = prodOrders.filter(o => o.status === 'ملغاة').slice(0, 5);
    // الجودة: ملخص الدفعات + أسباب الرفض (من اللوتات مباشرة)
    let qPending = 0, qAccepted = 0, qRejected = 0;
    const rejReasons = {};
    for (const l of lots) {
      if (l.qc_final === 'مقبولة') qAccepted++;
      else if (l.qc_final === 'مرفوضة') {
        qRejected++;
        const rs = String((l.lab && l.lab.note) || 'بدون سبب مسجل').trim().slice(0, 60) || 'بدون سبب مسجل';
        rejReasons[rs] = (rejReasons[rs] || 0) + 1;
      }
      else if (l.qc === 'تمرير استثنائي' && !l.lab) qPending++;
    }
    const topReasons = Object.entries(rejReasons).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count }));
    // المبيعات: اليوم + التحصيل الشهري + الفواتير المتأخرة (>30 يوم بمتبقٍ)
    const paidByInv = {};
    for (const x of sd.receipts || []) paidByInv[x.invoice_id] = r2((paidByInv[x.invoice_id] || 0) + Number(x.amount || 0));
    let collectedMonth = 0;
    for (const x of sd.receipts || []) if (String(x.date || '').startsWith(month)) collectedMonth = r2(collectedMonth + Number(x.amount || 0));
    let salesOverdue = 0;
    for (const o of sd.invoices || []) {
      if (o.status !== 'مؤكدة') continue;
      let retVal = 0;
      for (const rt of (sd.returns || [])) {
        if (Number(rt.invoice_id) !== Number(o.id)) continue;
        for (const l of rt.lines || []) {
          const ol = (o.lines || []).find(y => Number(y.item_id) === Number(l.item_id));
          retVal = r2(retVal + Number(l.qty || 0) * Number(ol ? ol.price : 0));
        }
      }
      const rem = r2(Number(o.total || 0) - (paidByInv[o.id] || 0) - retVal);
      if (rem > 0 && ageDays(o.date, t) !== null && ageDays(o.date, t) > OVERDUE_DAYS) salesOverdue++;
    }
    // المخزون: تحت الحد + قريبة الانتهاء + القيمة (من balance واللوتات)
    const lowCount = bal.filter(r => r.status === 'low').length;
    const expiringCount = lots.filter(l => Number(l.remaining || 0) > 0 && l.days_left !== null && l.days_left !== undefined && l.days_left >= 0 && l.days_left <= 60).length;
    const stockValue = r2(bal.reduce((s, r) => s + Number(r.value || 0), 0));
    // المشتريات: موافقات متأخرة (>7 أيام)
    const weekAgo = plusDays(t, -7);
    const overdueApproval = pendAppr.filter(o => String(o.date || '') < weekAgo).length;
    // التدفق النقدي: صافي آخر 3 أشهر من المقارنة
    const last3 = cmp.slice(-3).map(m => ({ month: m.month, net: m.net }));
    const cashDirection = last3.length >= 2 ? (last3[last3.length - 1].net > last3[0].net ? 'up' : last3[last3.length - 1].net < last3[0].net ? 'down' : 'flat') : 'flat';
    // تكلفة الطن: متوسط مرجح لتكلفة اللوتات التامة المتبقية (تحويل الوحدات للطن)
    const toTons = (qty, unit) => {
      const q = Number(qty || 0);
      if (!(q > 0)) return 0;
      if (unit === 'طن') return q;
      if (unit === 'قنطار') return q / 10;
      if (unit === 'كغ') return q / 1000;
      return 0;
    };
    let finVal = 0, finTons = 0;
    for (const l of lots) {
      if (whType[l.warehouse_id] !== 'منتج نهائي') continue;
      const tn = toTons(l.remaining, l.unit);
      if (tn > 0 && Number(l.cost_per_unit || 0) > 0) { finTons = r2(finTons + tn); finVal = r2(finVal + Number(l.value || 0)); }
    }
    const costPerTon = finTons > 0 ? Math.round(finVal / finTons) : null;
    // مركز العمليات (للداشبورد فقط — لا يدخل alerts المشتركة): ما يحتاج تدخلاً الآن
    const ops = [];
    if (overdueApproval > 0) ops.push({ level: 'red', text: 'موافقات متأخرة (>7 أيام): ' + overdueApproval + ' طلبية', section: 'procurement' });
    if (stoppedProd.length) ops.push({ level: 'yellow', text: 'أوامر إنتاج ملغاة: ' + stoppedProd.length + ' (' + stoppedProd.map(o => o.num).slice(0, 3).join('، ') + ')', section: 'production' });
    if (qPending > 0) ops.push({ level: 'yellow', text: 'دفعات بانتظار قرار الجودة: ' + qPending, section: 'quality' });
    if (salesOverdue > 0) ops.push({ level: 'red', text: 'فواتير متأخرة التحصيل (>30 يوم): ' + salesOverdue, section: 'sales' });
    return {
      data: {
        kpis: {
          cash: fk.cash, net: fk.net, payables: fk.payables, receivables: fk.receivables,
          stockRaw, stockFin, prodWeek: pk.week, prodMonth: pk.month, salesMonth: sk.month,
          alerts: alerts.length
        },
        showMoney: canMoney,
        chart6: canMoney ? cmp.map(m => ({ month: m.month, revenue: m.revenue, expenses: m.expenses })) : [],
        top, alerts, alertsTotal: alertsAll.length,
        recent: rec.slice(0, 10),
        orders: { pendingApproval: pendAppr.length, approvedWaiting: apprWait.length, partial: partial.length },
        // توسعة إدارية (إضافة فقط)
        production: { today: pk.today, week: pk.week, month: pk.month, wip: pk.wip, wastePct: pk.wastePct, byStatus: prodByStatus },
        quality: { pending: qPending, accepted: qAccepted, rejected: qRejected, reasons: topReasons },
        salesX: { today: (sk.today || 0), collectedMonth, returnsMonth: (sk.returnsMonth || 0), overdue: salesOverdue },
        inventoryX: { lowCount, expiringCount, stockValue },
        procurementX: { overdueApproval },
        cashflow: { last3, direction: cashDirection },
        costPerTon,
        ops,
        updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
      }
    };
  }
};

module.exports = Dash;

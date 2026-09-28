// أزرار التصفير المؤقتة للاختبار — للمدير العام فقط، بنسخة أمان تلقائية قبل كل تصفير
// القاعدة الذهبية: البيانات التأسيسية (أصناف/جهات/مخازن/تركيبات/مستخدمون/إعدادات) لا تُمس أبداً.
// resetSales: يمسح الفواتير والتحصيلات والمرتجعات + يعكس آثارها المخزنية (استعادة المخصوم، حذف لوتات المرتجع)
// resetProcurement: يمسح الطلبيات والعربونات والتأكيدات + يحذف لوتات الاستلام (مسموح فقط بلا إنتاج متقدم وبلا مبيعات مؤكدة)
const fs = require('node:fs');
const path = require('node:path');
const jstore = require('./jstore');
const mstore = require('./store');

const now = () => new Date().toISOString();
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
function err(msg, code) { throw Object.assign(new Error(msg), { code: code || 400 }); }
function needAdmin(ctx) {
  if (!ctx || ctx.role !== 'admin') err('أزرار التصفير للمدير العام فقط', 403);
}
function safetyCopy(tag) {
  const AD = path.join(__dirname, '..', 'data-archive', 'manual-pre-' + tag + '-' + now().replace(/[:.]/g, '-').slice(0, 19));
  fs.mkdirSync(AD, { recursive: true });
  for (const f of ['sales.json', 'billing.json', 'procurement.json', 'production.json', 'inventory.json', 'finance.json', 'master.json', 'system.json', 'users.json', 'employees.json']) {
    const fp = path.join(__dirname, '..', 'data', f);
    if (fs.existsSync(fp)) fs.copyFileSync(fp, path.join(AD, f));
  }
  return AD.split(path.sep).pop();
}
function auditMaster(d, action, detail, ctx) {
  d.audit.push({ id: d.seq.audit++, action, entity: 'system', ref_id: 0, by: (ctx && ctx.user) || 'admin', role: ((ctx && ctx.role) || 'admin') + ' (' + detail + ')', at: now() });
  if (d.audit.length > 500) d.audit = d.audit.slice(-500);
}

const Reset = {
  sales(b, ctx) {
    needAdmin(ctx);
    if (String((b || {}).confirm || '') !== 'RESET-SALES') err('اكتب RESET-SALES للتأكيد');
    const sd = jstore('sales.json', { seq: {}, invoices: [], receipts: [], returns: [] }).load();
    const inv = jstore('inventory.json', { seq: {}, lots: [], movements: [] }).load();
    const fin = jstore('finance.json', { seq: {}, payables: [], receivables: [] }).load();
    const md = mstore.load();
    const invIds = new Set((sd.invoices || []).map(x => Number(x.id)));
    const invNums = new Set((sd.invoices || []).map(x => String(x.num || '')));
    const retNums = new Set((sd.returns || []).map(x => String(x.num || '')));
    // 1) قابلية العكس: لوتات المرتجع يجب ألا تكون قد بيعت/حُوّلت خارج مجموعتها بعد إرجاعها
    const retLots = (inv.lots || []).filter(l => retNums.has(String(l.order_num || '')));
    const retIds = new Set(retLots.map(l => Number(l.id)));
    const byTnumS = {};
    for (const m of (inv.movements || [])) {
      if (m.source && m.source.kind === 'تحويل' && m.source.num) {
        (byTnumS[m.source.num] = byTnumS[m.source.num] || []).push(m);
      }
    }
    for (const lot of retLots) {
      const strange = (inv.movements || []).filter(m => Number(m.lot_id) === Number(lot.id)
        && !(m.type === 'دخول' && m.source && m.source.kind === 'طلبية' && retNums.has(String((m.source.num) || '')))
        && !(m.source && m.source.kind === 'تحويل' && m.source.num && (byTnumS[m.source.num] || []).every(x => x.lot_id == null || retIds.has(Number(x.lot_id)))));
      if (strange.length) err('تعذر التصفير: اللوت ' + lot.lot_no + ' (مرتجع) له حركات لاحقة — احذفها يدوياً أولاً', 409);
    }
    const safety = safetyCopy('reset-sales');
    // 2) عكس خروج الفواتير (منتجات + أكياس: نفس المصدر فاتورة/الرقم)
    let reversed = 0;
    for (const m of (inv.movements || [])) {
      if (m.type === 'خروج' && m.source && m.source.kind === 'فاتورة' && invNums.has(String(m.source.num || ''))) {
        const lot = (inv.lots || []).find(l => Number(l.id) === Number(m.lot_id));
        if (lot) lot.remaining = r2(Number(lot.remaining || 0) + Math.abs(Number(m.qty || 0)));
        m._wiped = true;
        reversed++;
      }
    }
    inv.movements = (inv.movements || []).filter(m => !m._wiped);
    // 3) حذف حركات دخول المرتجعات ولوتاتها
    const retLotIds = new Set(retLots.map(l => Number(l.id)));
    const delMov = (inv.movements || []).filter(m => m.lot_id != null && retLotIds.has(Number(m.lot_id))).length;
    inv.movements = (inv.movements || []).filter(m => !(m.lot_id != null && retLotIds.has(Number(m.lot_id))));
    inv.lots = (inv.lots || []).filter(l => !retLotIds.has(Number(l.id)));
    // 4) مسح المبيعات والذمم المرتبطة (العدادات تبقى متسلسلة بلا إعادة)
    const cInv = (sd.invoices || []).length, cRec = (sd.receipts || []).length, cRet = (sd.returns || []).length;
    sd.invoices = []; sd.receipts = []; sd.returns = [];
    const cRecv = (fin.receivables || []).filter(x => invIds.has(Number(x.invoice_id))).length;
    fin.receivables = (fin.receivables || []).filter(x => !invIds.has(Number(x.invoice_id)));
    // وثائق الفوترة تابعة للفواتير — تُمسح معها وإلا بقيت يتيمة (لا تُسترجع)
    try {
      const Billing = require('./billing');
      for (const iid of invIds) { try { Billing.onInvoiceDeleted(iid); } catch {} }
    } catch {}
    auditMaster(md, 'reset_sales', 'فواتير:' + cInv + ' تحصيل:' + cRec + ' مرتجع:' + cRet, ctx);
    jstore('sales.json', {}).save(sd);
    jstore('inventory.json', {}).save(inv);
    jstore('finance.json', {}).save(fin);
    mstore.save(md);
    return { data: { safety, invoices: cInv, receipts: cRec, returns: cRet, movs_reversed: reversed, return_lots_removed: retLots.length, return_movs_removed: delMov, receivables_removed: cRecv } };
  },

  trial(b, ctx) {
    needAdmin(ctx);
    if (String((b || {}).confirm || '') !== 'RESET-TRIAL') err('اكتب RESET-TRIAL للتأكيد');
    // الترتيب إجباري: المبيعات أولا (تعكس المخزون) ثم التوريدات (تمسح الإنتاج ضمنا)
    const r1 = this.sales({ confirm: 'RESET-SALES' }, ctx);
    const r2p = this.procurement({ confirm: 'RESET-PROCUREMENT' }, ctx);
    // مسح طلبيات الزبائن الداخلية والخارجية (بلا أثر مخزني — للتجربة فقط)
    try {
      const sd = jstore('sales.json', {}).load();
      const cCmd = (sd.cmdorders || []).length;
      const cExt = (sd.extorders || []).length;
      sd.cmdorders = [];
      sd.extorders = [];
      jstore('sales.json', {}).save(sd);
      return { data: { safety: [r1.data.safety, r2p.data.safety], sales: r1.data, procurement: r2p.data, cmdorders: cCmd, extorders: cExt, kept: 'البيانات الأساسية (3) محفوظة' } };
    } catch (e) {
      return { data: { safety: [r1.data.safety, r2p.data.safety], sales: r1.data, procurement: r2p.data, kept: 'البيانات الأساسية (3) محفوظة' } };
    }
  },

  procurement(b, ctx) {
    needAdmin(ctx);
    if (String((b || {}).confirm || '') !== 'RESET-PROCUREMENT') err('اكتب RESET-PROCUREMENT للتأكيد');
    const pd = jstore('procurement.json', { seq: {}, orders: [], deposits: [], confirmations: [] }).load();
    const inv = jstore('inventory.json', { seq: {}, lots: [], movements: [] }).load();
    const fin = jstore('finance.json', { seq: {}, payables: [], receivables: [] }).load();
    const md = mstore.load();
    // 1) الشرط الوحيد: بلا مبيعات مؤكدة/مرتجعات (المبيعات تُصفَّر أولاً بزرها — هي تسترجع اللوتات التامة)
    const saled = jstore('sales.json', { invoices: [], returns: [] }).load();
    if ((saled.invoices || []).some(x => x.status === 'مؤكدة') || (saled.returns || []).length) {
      err('تعذر تصفير التوريدات: توجد مبيعات مؤكدة/مرتجعات مبنية على المخزون — صفّر المبيعات أولاً', 409);
    }
    const orderNums = new Set((pd.orders || []).map(x => String(x.num || '')));
    const orderIds = new Set((pd.orders || []).map(x => Number(x.id)));
    // لوتات الاستلام (بما فيها أبناء التحويل — تحمل نفس order_num)
    const gotLots = (inv.lots || []).filter(l => orderNums.has(String(l.order_num || '')));
    const gotIds = new Set(gotLots.map(l => Number(l.id)));
    // لوتات التام (OF-*) تُحذف ضمناً مع التوريدات التي غذّتها — تُحتسب مبكراً لفحص التحويلات المغلقة
    const prodLotIds = new Set((inv.lots || []).filter(l => /^OF-/i.test(String(l.order_num || ''))).map(l => Number(l.id)));
    // حركات غريبة على لوتات الاستلام تُمنع إلا التحويل المغلق داخل المجموعة
    const byTnum = {};
    for (const m of (inv.movements || [])) {
      if (m.source && m.source.kind === 'تحويل' && m.source.num) {
        (byTnum[m.source.num] = byTnum[m.source.num] || []).push(m);
      }
    }
    for (const lot of gotLots) {
      for (const m of (inv.movements || []).filter(x => Number(x.lot_id) === Number(lot.id))) {
        const isEntry = m.type === 'دخول' && m.source && m.source.kind === 'طلبية' && orderNums.has(String(m.source.num || ''));
        const isFix = m.type === 'دخول' && m.source && m.source.kind === 'تصحيح';
        // خروج الإنتاج يُعكس في الخطوة 2 ثم يُحذف مع اللوت — مستثنى من المنع
        const isProdOut = m.type === 'خروج' && m.source && m.source.kind === 'إنتاج';
        let closedTransfer = false;
        if (m.source && m.source.kind === 'تحويل' && m.source.num && byTnum[m.source.num]) {
          closedTransfer = byTnum[m.source.num].every(x => x.lot_id == null || gotIds.has(Number(x.lot_id)) || prodLotIds.has(Number(x.lot_id)));
        }
        if (!(isEntry || isFix || isProdOut || closedTransfer)) {
          err('تعذر التصفير: اللوت ' + lot.lot_no + ' له حركة لاحقة (' + m.type + ' ' + ((m.source && m.source.kind) || '') + ') — عالجها يدوياً أولاً', 409);
        }
      }
    }
    const safety = safetyCopy('reset-procurement');
    // 2) عكس استهلاك الإنتاج المرتبط (أوامر الإنتاج تُمسح ضمناً — التوريدات أساسها)
    const prodd = jstore('production.json', { seq: {}, orders: [] }).load();
    let prodReversed = 0;
    for (const m of (inv.movements || [])) {
      if (m.type === 'خروج' && m.source && m.source.kind === 'إنتاج') {
        const lot = (inv.lots || []).find(l => Number(l.id) === Number(m.lot_id));
        if (lot && gotIds.has(Number(lot.id))) {
          lot.remaining = r2(Number(lot.remaining || 0) + Math.abs(Number(m.qty || 0)));
          m._wiped = true;
          prodReversed++;
        }
      }
    }
    inv.movements = (inv.movements || []).filter(m => !m._wiped);
    // 3) حذف لوتات الاستلام وكل حركاتها + لوتات التام المنتجة منها + حركاتها
    const delMov1 = (inv.movements || []).filter(m => m.lot_id != null && (gotIds.has(Number(m.lot_id)) || prodLotIds.has(Number(m.lot_id)))).length;
    inv.movements = (inv.movements || []).filter(m => !(m.lot_id != null && (gotIds.has(Number(m.lot_id)) || prodLotIds.has(Number(m.lot_id)))));
    inv.lots = (inv.lots || []).filter(l => !(gotIds.has(Number(l.id)) || prodLotIds.has(Number(l.id))));
    const cProd = (prodd.orders || []).length;
    prodd.orders = [];
    // 4) مسح التوريدات والمستحقات المرتبطة (last_price مرجعي يُترك كما هو)
    const cOrd = (pd.orders || []).length, cDep = (pd.deposits || []).length, cConf = (pd.confirmations || []).length;
    pd.orders = []; pd.deposits = []; pd.confirmations = [];
    const cPay = (fin.payables || []).filter(x => orderIds.has(Number(x.order_id))).length;
    fin.payables = (fin.payables || []).filter(x => !orderIds.has(Number(x.order_id)));
    auditMaster(md, 'reset_procurement', 'طلبيات:' + cOrd + ' عربون:' + cDep + ' تأكيد:' + cConf + ' إنتاج:' + cProd, ctx);
    jstore('procurement.json', {}).save(pd);
    jstore('production.json', {}).save(prodd);
    jstore('inventory.json', {}).save(inv);
    jstore('finance.json', {}).save(fin);
    mstore.save(md);
    return { data: { safety, orders: cOrd, deposits: cDep, confirmations: cConf, production_orders: cProd, prod_movs_reversed: prodReversed, lots_removed: gotIds.size + prodLotIds.size, movs_removed: delMov1, payables_removed: cPay } };
  }
};

module.exports = Reset;

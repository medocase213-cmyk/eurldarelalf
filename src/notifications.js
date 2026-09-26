// التنبيهات الموحدة لكل الأقسام — مصدر واحد لجرس التنبيهات في كل رأس صفحة
// القاعدة: إعادة استعمال Dash.full (لا تكرار لمنطق التنبيهات) + ترشيح حسب:
//  1) إعدادات النظام (system.notifications: lowStock/expiry/pending/debts)
//  2) صلاحيات الدور (view لكل قسم) — لا يُعرض تنبيه لقسم محجوب عن المستخدم
//  3) الروابط: section -> صفحة القسم (يحوّلها الفرونت للمسار النسبي الصحيح)
const Dash = require('./dashboard');
const Auth = require('./auth');
const jstore = require('./jstore');

// القسم -> (صلاحية العرض المطلوبة + صفحة الوجهة + التسمية العربية)
const SECTION_META = {
  inventory: { view: ['inventory', 'view'], page: 'inventory/index.html', label: 'المخزون' },
  lots: { view: ['trace', 'view'], page: 'lots/index.html', label: 'الدفعات والتتبع', fallbackView: ['inventory', 'view'] },
  procurement: { view: ['procurement', 'view'], page: 'procurement/index.html', label: 'المشتريات' },
  finance: { view: ['finance', 'view'], page: 'finance/index.html', label: 'المالية' },
  quality: { view: ['quality', 'view'], page: 'quality-control/index.html', label: 'الجودة' },
  production: { view: ['production', 'view'], page: 'production/index.html', label: 'الإنتاج' },
  sales: { view: ['sales', 'view'], page: 'sales/index.html', label: 'المبيعات' },
  ext: { view: ['sales', 'view'], page: 'sales/index.html?tab=ext', label: 'الطلبات الخارجية' },
  custdebt: { view: ['sales', 'view'], page: 'sales/index.html?tab=custact', label: 'ديون الزبائن' },
  finprod: { view: ['inventory', 'view'], page: 'inventory/index.html', label: 'المنتجات النهائية', fallbackView: ['production', 'view'] },
};

// تصنيف التنبيه -> مفتاح إعداد النظام (نفس مفاتيح system.js الأربعة)
function notifKey(a) {
  const t = String(a.text || '');
  if (/طلب خارجي/.test(t)) return 'extOrders';
  if (/دين زبون/.test(t)) return 'custDebts';
  if (/منتج تام/.test(t)) return 'finProd';
  if (/دفعة منتهية|قرب انتهاء/.test(t)) return 'expiry';
  if (/تحت الحد|قرب الحد|مخزن خام/.test(t)) return 'lowStock';
  if (/بانتظار الموافقة|جزئية مفتوحة|مرفوضة محجوبة/.test(t)) return 'pending';
  if (/دين متأخر|رصيد سالب|تجاوز سقف/.test(t)) return 'debts';
  if (/خامل|الخمول|طلبية نائمة/.test(t)) return 'pending';
  return null;
}

function loadNotifSettings() {
  try {
    const d = jstore('system.json', { notifications: {} }).load();
    return Object.assign({ lowStock: true, expiry: true, pending: true, debts: true, extOrders: true, custDebts: true, finProd: true }, d.notifications || {});
  } catch { return { lowStock: true, expiry: true, pending: true, debts: true, extOrders: true, custDebts: true, finProd: true }; }
}

function canSee(ctx, section) {
  const m = SECTION_META[section];
  if (!m) return true;
  try {
    if (Auth.can(ctx.role, m.view[0], m.view[1])) return true;
    if (m.fallbackView && Auth.can(ctx.role, m.fallbackView[0], m.fallbackView[1])) return true;
    return false;
  } catch { return true; }
}

const Notifications = {
  SECTION_META,
  list(ctx) {
    const settings = loadNotifSettings();
    let alerts = [];
    try {
      alerts = (Dash.full(ctx).data.alerts || []).slice();
    } catch (e) { alerts = []; }
    // أجراس مخصصة: طلبات خارجية + ديون زبائن + منتجات تامة (مصادر مباشرة خفيفة)
    try {
      const sd = jstore('sales.json', { extorders: [] }).load();
      const nowMs = Date.now();
      for (const o of (sd.extorders || [])) {
        if (o.status !== 'جديدة' && o.status !== 'مؤجلة') continue;
        const ageH = (nowMs - Date.parse(o.created_at || '')) / 3600000;
        alerts.push({
          section: 'ext',
          level: (o.status === 'مؤجلة' || ageH > 12) ? 'red' : 'yellow',
          text: 'طلب خارجي ' + (o.status === 'مؤجلة' ? 'مؤجل' : 'جديد') + ' ' + (o.num || '') + ' — ' + (o.name || '')
        });
      }
    } catch (e) {}
    try {
      const Finance = require('./finance');
      const md = jstore('master.json', { customers: [], items: [], categories: [] }).load();
      const debtors = (Finance.debts().data.customers || [])
        .filter(x => Number(x.net || 0) > 0)
        .sort((a, b) => Number(b.net) - Number(a.net))
        .slice(0, 5);
      for (const x of debtors) {
        const c = (md.customers || []).find(k => Number(k.id) === Number(x.id)) || {};
        const over = Number(c.debt_limit || 0) > 0 && Number(x.net || 0) > Number(c.debt_limit);
        alerts.push({
          section: 'custdebt',
          level: over ? 'red' : 'yellow',
          text: 'دين زبون ' + (x.name || '') + ': ' + Number(x.net || 0) + ' دج' + (over ? ' (تجاوز السقف)' : '')
        });
      }
      const Sales = require('./sales');
      const av = {};
      try {
        for (const a of Sales.availability().data) av[Number(a.item_id)] = Number(a.remaining || 0);
      } catch (e2) {}
      for (const it of (md.items || [])) {
        const cat = (md.categories || []).find(k => Number(k.id) === Number(it.category_id));
        if (!cat || cat.main !== 'منتج نهائي' || it.status === 'متوقفة') continue;
        const rem = av[Number(it.id)] || 0;
        const min = Number(it.min_stock || 0);
        if (min > 0 && rem < min) {
          alerts.push({
            section: 'finprod',
            level: rem <= 0 ? 'red' : 'yellow',
            text: rem <= 0 ? 'منتج تام نافد: ' + it.name : 'منتج تام تحت الحد: ' + it.name + ' (' + rem + ' من ' + min + ')'
          });
        }
      }
    } catch (e) {}
    const items = [];
    for (const a of alerts) {
      const k = notifKey(a);
      if (k && settings[k] === false) continue; // يحترم إعدادات النظام
      if (!canSee(ctx, a.section)) continue; // يحترم مصفوفة الصلاحيات
      const m = SECTION_META[a.section] || { page: 'dashboard/index.html', label: 'لوحة القيادة' };
      items.push({
        level: a.level === 'red' ? 'red' : 'yellow',
        text: String(a.text || ''),
        section: a.section || '',
        sectionLabel: m.label || a.section || '',
        page: m.page,
      });
    }
    const red = items.filter(i => i.level === 'red').length;
    // ملخص per-section للشارة والقائمة المجمعة في الفرونت
    const bySection = {};
    for (const i of items) {
      bySection[i.section] = bySection[i.section] || { section: i.section, label: i.sectionLabel, page: i.page, count: 0, red: 0 };
      bySection[i.section].count += 1;
      if (i.level === 'red') bySection[i.section].red += 1;
    }
    return {
      data: {
        count: items.length,
        red,
        yellow: items.length - red,
        items: items.slice(0, 30),
        bySection: Object.values(bySection),
        settings,
        updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      },
    };
  },
};

module.exports = Notifications;

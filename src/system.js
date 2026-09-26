// النظام: إعدادات مركزية (هوية/مالية/ترقيم/تنبيهات/سجل) — القيم الحالية هي الافتراضيات دائماً
const fs = require('node:fs');
const path = require('node:path');
const jstore = require('./jstore');

const db = jstore('system.json', {
  factory: { name: 'دار العلف', nameLatin: 'Dar Al-Alef', address: '', phone: '', commercialReg: '', taxId: '', artImp: '', bank: '' },
  finance: { currency: 'دج', fiscalStart: '01-01', tax: 0 },
  numbering: {
    order: 'BC-{YYYY}-{NNN}', lot: 'LOT-{YYYY}-{NNNN}', transfer: 'TV-{YYYY}-{NNN}',
    count: 'JR-{YYYY}-{NNN}', adjlot: 'ADJ-{YYYY}-{NNNN}', formula: 'TRK-{NNN}', category: 'CAT-{NNN}',
    production: 'OF-{YYYY}-{NNN}', invoice: 'SI-{YYYY}-{NNN}', receipt: 'RC-{YYYY}-{NNN}', ret: 'RT-{YYYY}-{NNN}',
    payment: 'PAY-{YYYY}-{NNN}', cmd: 'CMD-{YYYY}-{NNN}'
  },
  // أنماط الترميز لكل نوع (تبويب أكواد العناصر): auto تلقائي (+يدوي عند الفراغ) / manual يدوي إلزامي / off أرقام بلا بادئة
  codemode: {
    suppliers: { mode: 'auto', prefix: 'SUP' },
    customers: { mode: 'auto', prefix: 'CUS' },
    workers: { mode: 'auto', prefix: 'WRK' },
    warehouses: { mode: 'auto', prefix: 'WH' },
    items: { mode: 'auto', prefix: '' },
    categories: { mode: 'auto', prefix: 'CAT' },
    // أنماط مخصصة يضيفها المدير من تبويب الأكواد: key لاتيني ← {label, mode, prefix}
    custom: {}
  },
  notifications: { lowStock: true, expiry: true, pending: true, debts: true, extOrders: true, custDebts: true, finProd: true },
  // الضبط المركزي للتتبع الذكي (المرحلة 5): مهلة الخمول الافتراضية + عتبات حكم المصنع
  tracking: { defaultIdleDays: 7, vExcellent: 80, vStable: 60, vWarn: 40 },
  // تخصيص البطاقات (تبويب النظام 7): "القسم||الاسم الأصلي" ← {label?, icon?, hidden?}
  cards: {},
  // سياسة تكلفة القنطار: مصاريف التصنيع % + إضافات (أكياس/نقل/أخرى) — تُحفظ مركزياً وتبقى حتى تغييرها
  costing: { overhead: 5, bags: { on: true, amount: 0 }, transport: { on: true, amount: 0 }, other: { on: true, amount: 0 } },
  // الهوية البصرية (تبويب النظام 8): تخصيص كامل للمظهر بلا مساس بالوظائف
  branding: brandingDefaults(),
  // بطاقات المساعدة التفاعلية (تبويب النظام 9): تلميح سياقي + بطاقات التنبيه المبوبة
  helpCards: {
    hoverDelay: 2000, cardSize: 'm', fontFamily: 'cairo', fontSize: 14,
    textColor: '', bg: '', opacity: 100, elevation: 2,
    levels: { info: '#2563eb', warning: '#d97706', error: '#ea580c', critical: '#dc2626' }
  },
  // صفحة الترحيب العمومية (تبويب النظام 10): كل ما يظهر للزوار — تُدمج مع الافتراضيات دائماً
  landing: {
    announcement: { on: false, text: '' },
    heroTitle: '', heroSub: '', heroBadge: '',
    slider: [],
    colors: { primary: '#123524', accent: '#e8a51c', bg: '#f7faf7' },
    font: { family: 'Cairo', title: 32, base: 15 },
    contact: { phones: [], whatsapp: '', address: '', hours: '' },
    products: {},
    orderOn: true, orderNote: ''
  },
  changelog: []
});
const now = () => new Date().toISOString();
function err(msg, code) { throw Object.assign(new Error(msg), { code: code || 400 }); }
// ---------- أساس النسخ الاحترافي الشامل ----------
const DATA_DIR = path.join(__dirname, '..', 'data');
const ARCH_DIR = path.join(__dirname, '..', 'data-archive');
const BACKUP_FILES = ['master.json', 'procurement.json', 'inventory.json', 'finance.json', 'sales.json', 'billing.json', 'production.json', 'employees.json', 'users.json', 'system.json'];
// كل ملف ← الأقسام التي يغذيها (التغطية: من القسم 1 إلى 16)
const BACKUP_META = {
  'master.json': { sec: '3+8', name: 'البيانات الأساسية والتركيبات', icon: '🗂️', desc: 'الأصناف والجهات والمخازن وتركيبات الأعلاف' },
  'procurement.json': { sec: '4', name: 'المشتريات', icon: '🚚', desc: 'الطلبيات والعربونات وتأكيدات الاستلام' },
  'inventory.json': { sec: '5+6+7', name: 'الجودة والمخزون والدفعات', icon: '📦', desc: 'اللوتات والحركات والجرد والتوالف — تشمل فحوصات الجودة' },
  'production.json': { sec: '9', name: 'الإنتاج', icon: '🏭', desc: 'أوامر الإنتاج والاستهلاك والتكلفة' },
  'sales.json': { sec: '10', name: 'المبيعات', icon: '💵', desc: 'الفواتير والتحصيلات والمرتجعات' },
  'billing.json': { sec: '10', name: 'وثائق البيع (وصولات وفواتير)', icon: '🧾', desc: 'الوصولات المؤقتة والنهائية وفواتير الضرائب (تبعية لفواتير البيع)' },
  'finance.json': { sec: '11', name: 'المالية', icon: '💰', desc: 'الحسابات والمصاريف والإيرادات والتحويلات' },
  'employees.json': { sec: '12', name: 'الموظفون', icon: '👷', desc: 'الملفات والحضور والسلف والكشوف' },
  'users.json': { sec: '15', name: 'المستخدمون والصلاحيات', icon: '👥', desc: 'الحسابات والأدوار — استعادتها تنهي الجلسات الحالية', warn: true },
  'system.json': { sec: '1+16', name: 'الإعدادات والهوية', icon: '⚙️', desc: 'إعدادات المصنع والترقيم والتنبيهات والبطاقات والهوية البصرية' }
};
function dataPath(f) { return path.join(DATA_DIR, f); }
// تنقية قائمة الوحدات المطلوبة: فارغة/غائبة = الكل — وإلا تقاطع صالح غير فارغ
function cleanModules(m) {
  if (m === undefined || m === null) return BACKUP_FILES.slice();
  if (!Array.isArray(m)) err('الوحدات: قائمة غير صالحة');
  const out = Array.from(new Set(m.map(x => String(x)).filter(f => BACKUP_FILES.includes(f))));
  if (!out.length) err('اختر وحدة واحدة على الأقل');
  return out;
}
// إحصاء السجلات: مجموع أطوال المصفوفات + تفصيل أكبر المفاتيح
function fileStats(data) {
  let records = 0;
  const keys = [];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const k of Object.keys(data)) {
      if (k === '_meta') continue;
      const v = data[k];
      if (Array.isArray(v)) { records += v.length; keys.push({ k, n: v.length }); }
    }
  } else if (Array.isArray(data)) { records = data.length; }
  keys.sort((a, b) => b.n - a.n);
  return { records, keys: keys.slice(0, 8) };
}
// أرشفة الحماية + كتابة: تُستخدم في كل استعادة (ملف أو لقطة) — سلوك واحد موحد
const RETENTION_RESTORE = 20; // سقف مجلدات restore-* التلقائية (اليدوية manual-*/full-clean-* مقدسة لا تُمس)
function archiveAndWrite(names, getContent) {
  const stamp = now().replace(/[:.]/g, '-').slice(0, 19);
  const AD = path.join(ARCH_DIR, 'restore-' + stamp);
  fs.mkdirSync(AD, { recursive: true });
  for (const k of names) {
    const fp = dataPath(k);
    if (fs.existsSync(fp)) fs.copyFileSync(fp, path.join(AD, k));
    fs.writeFileSync(fp, JSON.stringify(getContent(k), null, 2), 'utf8');
  }
  // تقليم التلقائي الفائض (الأقدم أولاً) — يحمي القرص من تضخم الاختبارات والاستعادات
  try {
    const dirs = fs.readdirSync(ARCH_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('restore-'))
      .map(e => e.name).sort();
    while (dirs.length > RETENTION_RESTORE) {
      const old = dirs.shift();
      fs.rmSync(path.join(ARCH_DIR, old), { recursive: true, force: true });
    }
  } catch {}
  return AD;
}
function snapIdOk(id) { return /^snap-\d{8}-\d{6}-[a-z0-9]{4}$/.test(String(id || '')); }
function readSnapMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(ARCH_DIR, String(id), 'meta.json'), 'utf8')); }
  catch { return null; }
}
function readSnaps() {
  try {
    fs.mkdirSync(ARCH_DIR, { recursive: true });
    return fs.readdirSync(ARCH_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.indexOf('snap-') === 0)
      .map(e => readSnapMeta(e.name))
      .filter(m => m && m.id)
      .sort((a, b) => String(b.at || '') < String(a.at || '') ? -1 : 1)
      .slice(0, 50);
  } catch { return []; }
}
// مرجع الهوية الوحيد (افتراضيات المصنع): يُستخدم في التهيئة والتطبيع والحفظ
function brandingDefaults() {
  return {
    font: { family: 'cairo', size: 14, weight: 400, color: '#1e293b' },
    colors: { primary: '#1b7a3d', secondary: '#e8a51c', background: '#f4f6f4', surface: '#ffffff', text: '#1e293b', autoBg: true },
    dark: { enabled: false, background: '#0f172a', surface: '#1e293b', text: '#e2e8f0' },
    tables: { bg: '#ffffff', headerBg: '#f8fafc', headerText: '#1e293b', text: '', border: '#e2e8f0', selected: '' },
    cards: { bg: '#ffffff', border: '#e2e8f0', shadow: 1, opacity: 100 },
    buttons: { bg: '#1b7a3d', text: '#ffffff', border: '', size: 'm', fx: 'none' },
    alerts: { info: '#2563eb', warning: '#e67e22', error: '#ea580c', critical: '#c0392b' },
    radius: 12,
    func: { add: '#16A34A', save: '#15803D', edit: '#2563EB', view: '#7C3AED', export: '#EAB308', import: '#F97316', delete: '#DC2626', cancel: '#4B5563', close: '#6B7280', search: '#0891B2', print: '#1E3A8A', copy: '#0284C7', refresh: '#0D9488', pin: '#6D28D9', settings: '#92400E', stock: '#1D4ED8', pay: '#059669', invoice: '#1E40AF', ship: '#C2410C' },
    layout: { density: 'm' }
  };
}
// تطبيع للقراءة: يكمل النواقص (بيانات قديمة قبل إضافة مفاتيح) دون كتابة
function normBranding(b) {  const d = brandingDefaults();
  if (!b || typeof b !== 'object') return d;
  const out = Object.assign({}, d, b);
  for (const sec of Object.keys(d)) {
    if (sec === 'radius') continue;
    out[sec] = Object.assign({}, d[sec], (b[sec] && typeof b[sec] === 'object') ? b[sec] : {});
  }
  return out;
}
// تطبيع إعدادات صفحة الترحيب (افتراضيات + دمج المحفوظ + تنقية دفاعية)
const LANDING_FONTS = ['Cairo', 'Tajawal', 'Almarai', 'Readex Pro'];
function normHex(v, dflt) { return /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : dflt; }
function normLanding(v) {
  const d = {
    announcement: { on: false, text: '' },
    heroTitle: '', heroSub: '', heroBadge: '',
    slider: [],
    colors: { primary: '#123524', accent: '#e8a51c', bg: '#f7faf7' },
    font: { family: 'Cairo', title: 32, base: 15 },
    contact: { phones: [], whatsapp: '', address: '', hours: '' },
    products: {},
    orderOn: true, orderNote: ''
  };
  if (!v || typeof v !== 'object') return d;
  const s = (x, n) => String(x == null ? '' : x).slice(0, n);
  if (v.announcement && typeof v.announcement === 'object') {
    d.announcement.on = !!v.announcement.on;
    d.announcement.text = s(v.announcement.text, 140);
  }
  d.heroTitle = s(v.heroTitle, 80); d.heroSub = s(v.heroSub, 160); d.heroBadge = s(v.heroBadge, 60);
  if (Array.isArray(v.slider)) {
    for (const it of v.slider.slice(0, 10)) {
      if (!it || typeof it !== 'object') continue;
      const img = s(it.img, 700000);
      // رابط خارجي أو صورة محلية base64 (مضغوطة من المتصفح — حد 700KB ليناسب حد الطلب)
      const okUrl = /^https?:\/\/.+/i.test(img);
      const okData = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(img);
      if (!okUrl && !okData) continue;
      d.slider.push({ img, title: s(it.title, 80), sub: s(it.sub, 160) });
    }
  }
  if (v.colors && typeof v.colors === 'object') {
    d.colors.primary = normHex(v.colors.primary, d.colors.primary);
    d.colors.accent = normHex(v.colors.accent, d.colors.accent);
    d.colors.bg = normHex(v.colors.bg, d.colors.bg);
  }
  if (v.font && typeof v.font === 'object') {
    if (LANDING_FONTS.includes(v.font.family)) d.font.family = v.font.family;
    const t = Number(v.font.title), b2 = Number(v.font.base);
    if (Number.isFinite(t) && t >= 18 && t <= 60) d.font.title = Math.round(t);
    if (Number.isFinite(b2) && b2 >= 12 && b2 <= 24) d.font.base = Math.round(b2);
  }
  if (v.contact && typeof v.contact === 'object') {
    if (Array.isArray(v.contact.phones)) {
      for (const p of v.contact.phones.slice(0, 3)) {
        const digits = String(p || '').replace(/\D/g, '');
        if (digits.length >= 9 && digits.length <= 15) d.contact.phones.push(digits);
      }
    }
    const wa = String(v.contact.whatsapp || '').replace(/\D/g, '');
    if (wa && wa.length >= 9 && wa.length <= 15) d.contact.whatsapp = wa;
    d.contact.address = s(v.contact.address, 120);
    d.contact.hours = s(v.contact.hours, 120);
  }
  if (v.products && typeof v.products === 'object' && !Array.isArray(v.products)) {
    for (const k of Object.keys(v.products).slice(0, 200)) {
      if (!/^\d+$/.test(k)) continue;
      const e = v.products[k];
      if (!e || typeof e !== 'object') continue;
      const price = e.price === null || e.price === undefined || e.price === '' ? null : Number(e.price);
      const old = e.old === null || e.old === undefined || e.old === '' ? null : Number(e.old);
      d.products[k] = {
        show: e.show !== false,
        price: (price === null || !Number.isFinite(price) || price < 0) ? null : Math.round(price * 100) / 100,
        old: (old === null || !Number.isFinite(old) || old < 0) ? null : Math.round(old * 100) / 100
      };
    }
  }
  d.orderOn = v.orderOn !== false;
  d.orderNote = s(v.orderNote, 200);
  return d;
}
// تطبيع أنماط الترميز للقراءة (افتراضيات + دمج المحفوظ)
const CODEMODE_FIXED = ['suppliers', 'customers', 'workers', 'warehouses', 'items', 'categories'];
// مفاتيح محجوزة لا تصلح كمفتاح نمط مخصص (أنواع ثابتة + مرقّمات مستندات + عدّادات داخلية)
const CODEMODE_RESERVED = CODEMODE_FIXED.concat(['custom', 'modes',
  'items_mat', 'items_prd', 'items_pac',
  'order', 'lot', 'transfer', 'count', 'adjlot', 'formula', 'category',
  'production', 'invoice', 'receipt', 'ret', 'payment']);
function normCustomEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const label = String(e.label == null ? '' : e.label).trim().replace(/\s+/g, ' ');
  if (label.length < 2 || label.length > 40) return null;
  const mode = String(e.mode || '').trim().toLowerCase();
  if (!['auto', 'manual', 'off'].includes(mode)) return null;
  const prefix = String(e.prefix == null ? '' : e.prefix).trim().toUpperCase();
  if (prefix && !/^[A-Z0-9]{1,6}$/.test(prefix)) return null;
  return { label, mode, prefix };
}
function normCodemode(v) {
  const dflt = {
    suppliers: { mode: 'auto', prefix: 'SUP' },
    customers: { mode: 'auto', prefix: 'CUS' },
    workers: { mode: 'auto', prefix: 'WRK' },
    warehouses: { mode: 'auto', prefix: 'WH' },
    items: { mode: 'auto', prefix: '' },
    categories: { mode: 'auto', prefix: 'CAT' }
  };
  const out = {};
  for (const k of Object.keys(dflt)) {
    const cur = (v && typeof v === 'object' && v[k] && typeof v[k] === 'object') ? v[k] : {};
    out[k] = {
      mode: ['auto', 'manual', 'off'].includes(cur.mode) ? cur.mode : dflt[k].mode,
      prefix: typeof cur.prefix === 'string' ? cur.prefix : dflt[k].prefix
    };
  }
  // تمرير الأنماط المخصصة بعد تنقيتها (إسقاط الفاسد دفاعياً حتى لا يكسر العرض)
  out.custom = {};
  try {
    const cv = (v && typeof v === 'object' && v.custom && typeof v.custom === 'object' && !Array.isArray(v.custom)) ? v.custom : {};
    for (const k of Object.keys(cv)) {
      if (!/^[a-z0-9_]{2,24}$/.test(k) || CODEMODE_RESERVED.includes(k)) continue;
      const n = normCustomEntry(cv[k]);
      if (n) out.custom[k] = n;
    }
  } catch {}
  return out;
}
// الأقسام التي تملك بطاقات قابلة للتخصيص (مفاتيح: "القسم||الاسم الأصلي")
const CARD_SECTIONS = ['dashboard', 'master-data', 'procurement', 'quality-control', 'inventory', 'lots', 'formulas', 'production', 'sales', 'finance', 'employees', 'users'];

const System = {
  get() {
    const d = db.load();
    d.branding = normBranding(d.branding); d.codemode = normCodemode(d.codemode);
    d.landing = normLanding(d.landing);
    // ترحيل صامت: صيغ ترقيم مستجدة (مثل cmd) تُضاف دون مساس بتخصيصات المدير
    try {
      d.numbering = d.numbering || {};
      if (!d.numbering.cmd) { d.numbering.cmd = 'CMD-{YYYY}-{NNN}'; db.save(d); }
    } catch {}
    return d;
  },
  pub() {
    const d = db.load();
    const openMode = ['1', 'true', 'yes', 'on'].includes(String(process.env.OPEN_MODE || '').toLowerCase());
    return { data: { factory: { name: (d.factory || {}).name || 'دار العلف', address: (d.factory || {}).address || '', phone: (d.factory || {}).phone || '', commercialReg: (d.factory || {}).commercialReg || '', taxId: (d.factory || {}).taxId || '', artImp: (d.factory || {}).artImp || '', bank: (d.factory || {}).bank || '' }, currency: ((d.finance || {}).currency) || 'دج', notifications: d.notifications || {}, cards: d.cards || {}, branding: normBranding(d.branding), helpCards: d.helpCards || {}, codemode: normCodemode(d.codemode), landing: normLanding(d.landing), openMode } };
    },
  // صيغة مثل BC-{YYYY}-{NNN} — نفس المخرجات القديمة حرفياً عند الافتراضيات
  formatNum(doc, o) {
    const d = db.load();
    const pat = ((d.numbering || {})[doc]) || '';
    if (!pat) err('صيغة ترقيم غير معرفة: ' + doc);
    const n = Number((o || {}).n);
    if (!Number.isInteger(n) || n < 1) err('رقم تسلسلي غير صالح');
    return pat
      .replace('{YYYY}', String((o || {}).year || new Date().getFullYear()))
      .replace(/\{N+\}/, m => String(n).padStart(m.length - 2, '0'));
  },
  // الضبط المركزي للتتبع الذكي: مدمج مع الافتراضيات دائماً (آمن ضد ملف تالف)
  tracking() {
    const DEF = { defaultIdleDays: 7, vExcellent: 80, vStable: 60, vWarn: 40 };
    try {
      const d = db.load();
      const t = (d && d.tracking) || {};
      const out = { ...DEF };
      if (Number.isInteger(t.defaultIdleDays) && t.defaultIdleDays >= 1 && t.defaultIdleDays <= 365) out.defaultIdleDays = t.defaultIdleDays;
      for (const k of ['vExcellent', 'vStable', 'vWarn']) {
        if (Number.isInteger(t[k]) && t[k] >= 0 && t[k] <= 100) out[k] = t[k];
      }
      if (!(out.vExcellent > out.vStable && out.vStable > out.vWarn)) return DEF;
      return out;
    } catch { return DEF; }
  },
  update(b, ctx) {
    if (ctx.role !== 'admin') err('الإعدادات للمدير العام فقط', 403);
    const d = db.load();
    if (b.factory !== undefined) {
      for (const k of ['name', 'nameLatin', 'address', 'phone', 'commercialReg', 'taxId', 'artImp', 'bank']) {
        if (b.factory[k] !== undefined) d.factory[k] = String(b.factory[k] || '').trim().slice(0, 120);
      }
      if (!d.factory.name) err('اسم المصنع مطلوب');
    }
    if (b.finance !== undefined) {
      if (b.finance.currency !== undefined) {
        if (!String(b.finance.currency).trim()) err('العملة مطلوبة');
        d.finance.currency = String(b.finance.currency).trim().slice(0, 10);
      }
      if (b.finance.fiscalStart !== undefined) {
        if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(String(b.finance.fiscalStart))) err('بداية السنة بصيغة MM-DD');
        d.finance.fiscalStart = String(b.finance.fiscalStart);
      }
      if (b.finance.tax !== undefined) {
        const t = Number(b.finance.tax);
        if (!Number.isFinite(t) || t < 0 || t > 100) err('الضريبة بين 0 و 100');
        d.finance.tax = t;
      }
    }
    if (b.numbering !== undefined) {
      for (const k of Object.keys(b.numbering)) {
        const p = String(b.numbering[k] || '');
        if (!p.includes('{NNN') && !p.includes('{NN}')) err('الصيغة يجب أن تحوي {NNN} على الأقل: ' + k);
        d.numbering[k] = p.slice(0, 40);
      }
    }
    // أنماط الترميز لكل نوع: auto (+يدوي عند التعبئة) / manual (يدوي إلزامي) / off (أرقام بلا بادئة)
    if (b.codemode !== undefined) {
      const v = b.codemode;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) err('أنماط الترميز غير صالحة');
      const known = CODEMODE_FIXED;
      for (const k of Object.keys(v)) {
        if (k === 'custom') continue; // تُعالج أدناه كخريطة كاملة
        if (!known.includes(k)) err('نوع ترميز غير صالح: ' + String(k).slice(0, 20));
        const e = v[k];
        if (typeof e !== 'object' || e === null || Array.isArray(e)) err('نمط الترميز غير صالح: ' + k);
        d.codemode = d.codemode || {};
        d.codemode[k] = d.codemode[k] || {};
        if (e.mode !== undefined) {
          const m = String(e.mode || '').trim().toLowerCase();
          if (!['auto', 'manual', 'off'].includes(m)) err('نمط ' + k + ': auto أو manual أو off');
          d.codemode[k].mode = m;
        }
        if (e.prefix !== undefined) {
          const pfx = String(e.prefix || '').trim().toUpperCase();
          if (pfx && !/^[A-Z0-9]{1,6}$/.test(pfx)) err('بادئة ' + k + ': 1-6 أحرف لاتينية/أرقام');
          d.codemode[k].prefix = pfx;
        }
      }
      // الأنماط المخصصة: استبدال كامل للخريطة (الحذف = إسقاط المفتاح) — تحقق صارم لكل مدخل
      if (v.custom !== undefined) {
        const cv = v.custom;
        if (typeof cv !== 'object' || cv === null || Array.isArray(cv)) err('الأنماط المخصصة غير صالحة');
        const keys = Object.keys(cv);
        if (keys.length > 50) err('عدد الأنماط المخصصة بحد أقصى 50');
        const next = {};
        for (const k of keys) {
          if (!/^[a-z0-9_]{2,24}$/.test(k)) err('مفتاح النمط "' + String(k).slice(0, 20) + '": 2-24 حرفاً لاتينياً صغيراً/أرقام/_');
          if (CODEMODE_RESERVED.includes(k)) err('مفتاح النمط "' + k + '" محجوز لنوع داخلي');
          const n = normCustomEntry(cv[k]);
          if (!n) err('مدخل النمط "' + k + '" غير صالح (الاسم 2-40 حرفاً + النوع auto/manual/off + بادئة اختيارية 1-6)');
          next[k] = n;
        }
        d.codemode = d.codemode || {};
        d.codemode.custom = next;
      }
    }
    if (b.notifications !== undefined) {
      for (const k of ['lowStock', 'expiry', 'pending', 'debts', 'extOrders', 'custDebts', 'finProd']) {
        if (b.notifications[k] !== undefined) d.notifications[k] = !!b.notifications[k];
      }
    }
    // إعدادات التتبع الذكي (المدير فقط): مهلة الخمول + عتبات الحكم مرتبة تنازلياً
    if (b.tracking !== undefined) {
      const v = b.tracking;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) err('إعدادات التتبع غير صالحة');
      d.tracking = d.tracking || {};
      if (v.defaultIdleDays !== undefined) {
        const n = Number(v.defaultIdleDays);
        if (!Number.isInteger(n) || n < 1 || n > 365) err('مهلة الخمول الافتراضية: عدد صحيح 1-365');
        d.tracking.defaultIdleDays = n;
      }
      for (const k of ['vExcellent', 'vStable', 'vWarn']) {
        if (v[k] !== undefined) {
          const n = Number(v[k]);
          if (!Number.isInteger(n) || n < 0 || n > 100) err('عتبات الحكم: 0-100');
          d.tracking[k] = n;
        }
      }
      const t = Object.assign({ defaultIdleDays: 7, vExcellent: 80, vStable: 60, vWarn: 40 }, d.tracking);
      if (!(t.vExcellent > t.vStable && t.vStable > t.vWarn)) err('ترتيب العتبات: ممتاز > مستقر > تحذير');
    }
    // تخصيص البطاقات: استبدال كامل للقاموس بعد تحقق صارم (كائن فارغ = استعادة الافتراضي)
    if (b.cards !== undefined) {
      if (typeof b.cards !== 'object' || b.cards === null || Array.isArray(b.cards)) err('البطاقات: كائن غير صالح');
      const keys = Object.keys(b.cards);
      if (keys.length > 200) err('عدد البطاقات المخصصة يتجاوز الحد (200)');
      const next = {};
      for (const k of keys) {
        const m = String(k).match(/^([a-z-]+)\|\|(.+)$/);
        if (!m || !CARD_SECTIONS.includes(m[1]) || !m[2] || m[2].length > 60) err('مفتاح بطاقة غير صالح: ' + String(k).slice(0, 40));
        const v = b.cards[k];
        if (typeof v !== 'object' || v === null || Array.isArray(v)) err('قيمة بطاقة غير صالحة: ' + String(k).slice(0, 40));
        const e = {};
        if (v.label !== undefined) {
          const s = String(v.label).trim().slice(0, 40);
          if (!s) err('اسم البطاقة مطلوب: ' + String(k).slice(0, 40));
          e.label = s;
        }
        if (v.icon !== undefined) {
          const s = String(v.icon).trim();
          if (!/^(svg:[a-z-]+|.{1,8})$/u.test(s)) err('أيقونة غير صالحة: ' + String(k).slice(0, 40));
          e.icon = s;
        }
        if (v.hidden !== undefined) e.hidden = !!v.hidden;
        if (Object.keys(e).length) next[k] = e;
      }
      d.cards = next;
    }
    // الهوية البصرية: دمج جزئي مع تحقق صارم (كائن فارغ/ناقص = دمج مع الحالي)
    if (b.branding !== undefined) {
      const v = b.branding;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) err('الهوية البصرية: كائن غير صالح');
      const keys = Object.keys(v);
      if (keys.length > 14) err('الهوية البصرية: حقول كثيرة');
      for (const k of keys) {
        if (!['font', 'colors', 'dark', 'tables', 'cards', 'buttons', 'alerts', 'radius', 'func', 'layout'].includes(k)) err('قسم هوية غير صالح: ' + String(k).slice(0, 20));
        if (typeof v[k] !== 'object' || v[k] === null || Array.isArray(v[k])) {
          if (k !== 'radius') err('قسم الهوية ' + k + ' غير صالح');
        }
      }
      const isHex = s => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(s || '').trim());
      const needHex = (val, label) => {
        const s = String(val || '').trim();
        if (!isHex(s)) err(label + ': لون hex غير صالح (مثال #1b7a3d)');
        return s;
      };
      const dflt = brandingDefaults();
      const cur = d.branding;
      const merge = (name, rules) => {
        if (v[name] === undefined) return;
        cur[name] = (cur[name] && typeof cur[name] === 'object') ? cur[name] : {};
        for (const f of Object.keys(v[name])) {
          if (!Object.prototype.hasOwnProperty.call(rules, f)) err('حقل هوية غير صالح: ' + name + '.' + String(f).slice(0, 20));
          cur[name][f] = rules[f](v[name][f], name + '.' + f);
        }
      };
      const num = (lo, hi, label) => val => {
        const n = Number(val);
        if (!Number.isFinite(n) || n < lo || n > hi) err(label + ': بين ' + lo + ' و ' + hi);
        return Math.round(n * 100) / 100;
      };
      const int = (lo, hi, label) => val => {
        const n = Number(val);
        if (!Number.isInteger(n) || n < lo || n > hi) err(label + ': بين ' + lo + ' و ' + hi);
        return n;
      };
      const hex = label => val => needHex(val, label);
      const hexOrEmpty = label => val => {
        const s = String(val === undefined || val === null ? '' : val).trim();
        if (s && !isHex(s)) err(label + ': لون hex غير صالح أو فارغ');
        return s;
      };
      const oneOf = (list, label) => val => {
        const s = String(val || '').trim().toLowerCase();
        if (!list.includes(s)) err(label + ': ' + list.join(' أو '));
        return s;
      };
      merge('font', { family: oneOf(['cairo', 'tajawal', 'system'], 'خط الهوية'), size: int(12, 18, 'حجم الخط'), weight: oneOf(['400', '500', '600', '700'], 'وزن الخط'), color: hex('لون الخط') });
      merge('colors', { primary: hex('اللون الرئيسي'), secondary: hex('اللون الثانوي'), background: hex('الخلفية'), surface: hex('خلفية البطاقات'), text: hex('لون النص'), autoBg: val => !!val });
      merge('dark', {
        enabled: val => !!val,
        background: hex('خلفية الداكن'), surface: hex('سطح الداكن'), text: hex('نص الداكن')
      });
      merge('tables', { bg: hex('خلفية الجدول'), headerBg: hex('رأس الجدول'), headerText: hex('نص الرأس'), text: hexOrEmpty('نص الجدول (فارغ = تلقائي)'), border: hex('حدود الجدول'), selected: hexOrEmpty('التحديد (فارغ = تلقائي)') });
      merge('cards', { bg: hex('خلفية البطاقات'), border: hex('حدود البطاقات'), shadow: int(0, 3, 'ظل البطاقات'), opacity: int(60, 100, 'شفافية البطاقات') });
      merge('buttons', { bg: hex('لون الأزرار'), text: hex('نص الأزرار'), border: hexOrEmpty('حدود الأزرار (فارغ = بلا)'), size: oneOf(['s', 'm', 'l'], 'حجم الأزرار'), fx: oneOf(['none', 'lift', 'glow'], 'تأثير الأزرار') });
      merge('alerts', { info: hex('تنبيه معلومات'), warning: hex('تنبيه تحذير'), error: hex('تنبيه خطأ'), critical: hex('تنبيه حرج') });
      merge('func', { add: hex('إضافة'), save: hex('حفظ'), edit: hex('تعديل'), view: hex('عرض'), export: hex('تصدير'), import: hex('استيراد'), delete: hex('حذف'), cancel: hex('إلغاء'), close: hex('إغلاق'), search: hex('بحث'), print: hex('طباعة'), copy: hex('نسخ'), refresh: hex('تحديث'), pin: hex('تثبيت'), settings: hex('إعدادات'), stock: hex('مخزون'), pay: hex('دفع'), invoice: hex('فواتير'), ship: hex('شحن') });
      merge('layout', { density: oneOf(['s', 'm', 'l'], 'كثافة العرض') });
      if (v.radius !== undefined) {
        const n = Number(v.radius);
        if (!Number.isInteger(n) || n < 0 || n > 16) err('استدارة الزوايا بين 0 و 16');
        d.branding.radius = n;
      }
      // إكمال النواقص بالافتراضيات (أول حفظ)
      for (const sec of Object.keys(dflt)) {
        if (typeof dflt[sec] === 'object') {
          d.branding[sec] = Object.assign({}, dflt[sec], d.branding[sec] || {});
          if (sec === 'dark' || sec === 'alerts' || sec === 'tables' || sec === 'cards' || sec === 'buttons' || sec === 'font' || sec === 'colors' || sec === 'func' || sec === 'layout') {
            for (const f of Object.keys(dflt[sec])) {
              if (d.branding[sec][f] === undefined) d.branding[sec][f] = dflt[sec][f];
            }
          }
        } else if (d.branding[sec] === undefined) d.branding[sec] = dflt[sec];
      }
    }
    // بطاقات المساعدة: دمج جزئي مع تحقق صارم
    if (b.helpCards !== undefined) {
      const v = b.helpCards;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) err('بطاقات المساعدة: كائن غير صالح');
      const dflt = { hoverDelay: 2000, cardSize: 'm', fontFamily: 'cairo', fontSize: 14, textColor: '', bg: '', opacity: 100, elevation: 2, levels: { info: '#2563eb', warning: '#d97706', error: '#ea580c', critical: '#dc2626' } };
      const cur = (d.helpCards && typeof d.helpCards === 'object') ? d.helpCards : {};
      const isHex = s => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(s || '').trim());
      const out = {
        hoverDelay: cur.hoverDelay !== undefined ? cur.hoverDelay : dflt.hoverDelay,
        cardSize: cur.cardSize !== undefined ? cur.cardSize : dflt.cardSize,
        fontFamily: cur.fontFamily !== undefined ? cur.fontFamily : dflt.fontFamily,
        fontSize: cur.fontSize !== undefined ? cur.fontSize : dflt.fontSize,
        textColor: cur.textColor !== undefined ? cur.textColor : dflt.textColor,
        bg: cur.bg !== undefined ? cur.bg : dflt.bg,
        opacity: cur.opacity !== undefined ? cur.opacity : dflt.opacity,
        elevation: cur.elevation !== undefined ? cur.elevation : dflt.elevation,
        levels: Object.assign({}, dflt.levels, cur.levels || {})
      };
      if (v.hoverDelay !== undefined) {
        const n = Number(v.hoverDelay);
        if (!Number.isFinite(n) || n < 500 || n > 3000) err('مدة ظهور البطاقة بين 500 و 3000 مللي ثانية');
        out.hoverDelay = Math.round(n);
      }
      if (v.cardSize !== undefined) {
        const s = String(v.cardSize || '').trim().toLowerCase();
        if (!['s', 'm', 'l'].includes(s)) err('حجم البطاقة: s أو m أو l');
        out.cardSize = s;
      }
      if (v.fontFamily !== undefined) {
        const s = String(v.fontFamily || '').trim().toLowerCase();
        if (!['cairo', 'tajawal', 'system'].includes(s)) err('خط البطاقات: cairo أو tajawal أو system');
        out.fontFamily = s;
      }
      if (v.fontSize !== undefined) {
        const n = Number(v.fontSize);
        if (!Number.isFinite(n) || n < 12 || n > 18) err('حجم نص البطاقات بين 12 و 18');
        out.fontSize = Math.round(n);
      }
      if (v.textColor !== undefined) {
        const s = String(v.textColor || '').trim();
        if (s && !isHex(s)) err('لون النص غير صالح (hex)');
        out.textColor = s;
      }
      if (v.bg !== undefined) {
        const s = String(v.bg || '').trim();
        if (s && !isHex(s)) err('لون الخلفية غير صالح (hex)');
        out.bg = s;
      }
      if (v.opacity !== undefined) {
        const n = Number(v.opacity);
        if (!Number.isFinite(n) || n < 60 || n > 100) err('شفافية البطاقات بين 60 و 100');
        out.opacity = Math.round(n);
      }
      if (v.elevation !== undefined) {
        const n = Number(v.elevation);
        if (!Number.isInteger(n) || n < 0 || n > 3) err('بروز البطاقات بين 0 و 3');
        out.elevation = n;
      }
      if (v.levels !== undefined) {
        if (typeof v.levels !== 'object' || v.levels === null || Array.isArray(v.levels)) err('ألوان المستويات غير صالحة');
        for (const k of ['info', 'warning', 'error', 'critical']) {
          if (v.levels[k] !== undefined) {
            const s = String(v.levels[k] || '').trim();
            if (!isHex(s)) err('لون المستوى ' + k + ' غير صالح (hex)');
            out.levels[k] = s;
          }
        }
      }
      d.helpCards = out;
    }
    if (b.costing !== undefined) {
      d.costing = d.costing || { overhead: 5, bags: { on: true, amount: 0 }, transport: { on: true, amount: 0 }, other: { on: true, amount: 0 } };
      const c = b.costing;
      if (c.overhead !== undefined) {
        const o = Number(c.overhead);
        if (!Number.isFinite(o) || o < 0 || o > 100) err('مصاريف التصنيع بين 0 و 100');
        d.costing.overhead = o;
      }
      for (const k of ['bags', 'transport', 'other']) {
        if (c[k] !== undefined) {
          d.costing[k] = d.costing[k] || { on: true, amount: 0 };
          if (c[k].on !== undefined) d.costing[k].on = !!c[k].on;
          if (c[k].amount !== undefined) {
            const a = Number(c[k].amount);
            if (!Number.isFinite(a) || a < 0) err('مبلغ الإضافة غير صالح');
            d.costing[k].amount = Math.round(a * 100) / 100;
          }
        }
      }
    }
    if (b.landing !== undefined) {
      d.landing = normLanding(b.landing);
    }
    db.save(d);
    return { data: d };
  },
  changelogAdd(b, ctx) {
    if (ctx.role !== 'admin') err('للمدير العام فقط', 403);
    if (!String(b.text || '').trim()) err('نص التحديث مطلوب');
    const d = db.load();
    d.changelog.unshift({ at: now(), by: ctx.user, text: String(b.text).trim().slice(0, 300) });
    if (d.changelog.length > 200) d.changelog = d.changelog.slice(0, 200);
    db.save(d);
    return { data: d.changelog };
  },
  // ---------- النسخ الاحترافي الشامل (تبويب النظام 4) ----------
  // كل ملف بيانات ← الأقسام التي يغذيها (من القسم 1 إلى 16)
  backupCatalog() {
    return {
      data: BACKUP_FILES.map(f => {
        const m = BACKUP_META[f];
        let exists = false, size = 0, mtime = '', records = 0, keys = [];
        try {
          const st = fs.statSync(dataPath(f));
          exists = true; size = st.size; mtime = st.mtime.toISOString();
          try {
            const s = fileStats(JSON.parse(fs.readFileSync(dataPath(f), 'utf8')));
            records = s.records; keys = s.keys;
          } catch {}
        } catch {}
        return { file: f, sec: m.sec, name: m.name, icon: m.icon, desc: m.desc, warn: !!m.warn, exists, size, mtime, records, keys };
      })
    };
  },
  // نسخة بيانات (تنزيل): كاملة افتراضياً، أو انتقائية بقائمة modules
  dataBackup(modules) {
    const files = cleanModules(modules);
    // اكتمال اللقطة: أي ملف متتبع غير موجود يُنشأ فارغاً أولاً — وإلا غابت مفاتيح
    // عن اللقطة فلا تُستعاد (وثائق يتيمة: إنتاج/فوترة خُلقا بعد اللقطة). الوحدات تملأ
    // هياكلها الافتراضية عند التحميل، فالملف الفارغ آمن تماماً.
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
    for (const f of files) {
      try { if (!fs.existsSync(dataPath(f))) fs.writeFileSync(dataPath(f), '{}', 'utf8'); } catch {}
    }
    const out = {};
    for (const f of files) {
      try { out[f] = JSON.parse(fs.readFileSync(dataPath(f), 'utf8')); } catch {}
    }
    out._meta = { at: now(), kind: files.length === BACKUP_FILES.length ? 'full' : 'partial', files: Object.keys(out).filter(k => k !== '_meta') };
    return { data: out };
  },
  dataRestore(b, ctx) {
    if (ctx.role !== 'admin') err('الاستعادة للمدير العام فقط', 403);
    if (String((b || {}).confirm || '') !== 'RESTORE') err('اكتب RESTORE للتأكيد');
    const files = (b || {}).files || {};
    const names = Object.keys(files).filter(k => BACKUP_FILES.includes(k));
    if (!names.length) err('لا ملفات صالحة للاستعادة');
    for (const k of names) {
      if (typeof files[k] !== 'object' || files[k] === null) err('ملف تالف: ' + k);
    }
    const AD = archiveAndWrite(names, k => files[k]);
    return { data: { restored: names, safety: AD } };
  },
  // لقطات الخادم: حفظ مسمى + قائمة + استعادة (كلية/انتقائية) + تنزيل + حذف — بأرشفة حماية تلقائية
  snapSave(b, ctx) {
    if (ctx.role !== 'admin') err('اللقطات للمدير العام فقط', 403);
    const files = cleanModules(b && b.modules);
    const label = String((b && b.label) == null ? '' : b.label).trim().slice(0, 60) || 'لقطة يدوية';
    const compact = now().replace(/[-:.TZ]/g, '').slice(0, 14);
    const rnd = Math.random().toString(36).slice(2, 6);
    const id = 'snap-' + compact.slice(0, 8) + '-' + compact.slice(8, 14) + '-' + rnd;
    const dir = path.join(ARCH_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const sizes = {};
    let records = 0;
    for (const f of files) {
      try {
        const raw = fs.readFileSync(dataPath(f), 'utf8');
        fs.writeFileSync(path.join(dir, f), raw, 'utf8');
        sizes[f] = Buffer.byteLength(raw, 'utf8');
        try { records += fileStats(JSON.parse(raw)).records; } catch {}
      } catch {}
    }
    const meta = { id, label, at: now(), by: (ctx && ctx.user) || '', modules: files, sizes, records };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    return { data: meta };
  },
  snapList(ctx) {
    if (ctx.role !== 'admin') err('اللقطات للمدير العام فقط', 403);
    return { data: readSnaps() };
  },
  snapGet(b, ctx) {
    if (ctx.role !== 'admin') err('اللقطات للمدير العام فقط', 403);
    const id = String((b && b.id) || '');
    if (!snapIdOk(id)) err('معرف لقطة غير صالح');
    const meta = readSnapMeta(id);
    if (!meta) err('اللقطة غير موجودة');
    const files = {};
    for (const f of meta.modules) {
      try { files[f] = JSON.parse(fs.readFileSync(path.join(ARCH_DIR, id, f), 'utf8')); } catch {}
    }
    return { data: { meta, files } };
  },
  snapRestore(b, ctx) {
    if (ctx.role !== 'admin') err('الاستعادة للمدير العام فقط', 403);
    if (String((b || {}).confirm || '') !== 'RESTORE') err('اكتب RESTORE للتأكيد');
    const id = String((b && b.id) || '');
    if (!snapIdOk(id)) err('معرف لقطة غير صالح');
    const meta = readSnapMeta(id);
    if (!meta) err('اللقطة غير موجودة');
    let names = meta.modules.slice();
    if (b && b.modules !== undefined) {
      const want = cleanModules(b.modules);
      names = want.filter(f => meta.modules.includes(f));
      if (!names.length) err('لا وحدات مشتركة بين طلبك وهذه اللقطة');
    }
    const snapFiles = {};
    for (const f of names) {
      try { snapFiles[f] = JSON.parse(fs.readFileSync(path.join(ARCH_DIR, id, f), 'utf8')); }
      catch { err('ملف اللقطة تالف: ' + f); }
      if (typeof snapFiles[f] !== 'object' || snapFiles[f] === null) err('ملف اللقطة تالف: ' + f);
    }
    const AD = archiveAndWrite(names, k => snapFiles[k]);
    return { data: { restored: names, safety: AD, snap: id } };
  },
  snapDelete(b, ctx) {
    if (ctx.role !== 'admin') err('حذف اللقطات للمدير العام فقط', 403);
    if (String((b || {}).confirm || '') !== 'DELETE') err('اكتب DELETE للتأكيد');
    const id = String((b && b.id) || '');
    if (!snapIdOk(id)) err('معرف لقطة غير صالح');
    const dir = path.join(ARCH_DIR, id);
    if (!fs.existsSync(dir)) err('اللقطة غير موجودة');
    fs.rmSync(dir, { recursive: true, force: true });
    return { data: { deleted: id } };
  },
  archives() {
    const AD = path.join(__dirname, '..', 'data-archive');
    try {
      fs.mkdirSync(AD, { recursive: true });
      return {
        data: fs.readdirSync(AD, { withFileTypes: true })
          .filter(e => e.isDirectory()).map(e => e.name).sort().reverse().slice(0, 50)
      };
    } catch { return { data: [] }; }
  }
};

module.exports = System;

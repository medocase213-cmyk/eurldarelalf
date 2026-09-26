// منطق البيانات الأساسية + القواعد التشغيلية المقفلة
const store = require('./store');
const System = require('./system');
const Auth = require('./auth');

const UNITS = ['كغ', 'قنطار', 'طن', 'وحدة'];
const MAIN_CATS = ['مواد أولية', 'منتج نهائي', 'تعبئة وتغليف'];
// مدة الصلاحية الافتراضية = 3 أشهر تلقائياً:
// - المنتجات النهائية (من تاريخ الإنتاج)
// - المواد الأولية (من تاريخ الوصول في تأكيد الطلبيات — تُدخل من بطاقة الصنف)
// تُطبق عند الإنشاء + ترحيل تلقائي للبطاقات القديمة. لا تمس التغليف ولا أي وظيفة أخرى.
const DEFAULT_PRD_SHELF_MONTHS = 3;
const DEFAULT_RAW_SHELF_MONTHS = 3;
const SHELF_MIN = 1, SHELF_MAX = 60;
function ensureShelfDefaults(d) {
  let touched = false;
  try {
    const cats = new Map((d.categories || []).map(c => [Number(c.id), c.main]));
    for (const it of (d.items || [])) {
      const main = cats.get(Number(it.category_id));
      if (main !== 'منتج نهائي' && main !== 'مواد أولية') continue;
      const v = Number(it.shelf_months);
      if (!Number.isFinite(v) || v <= 0) {
        it.shelf_months = main === 'منتج نهائي' ? DEFAULT_PRD_SHELF_MONTHS : DEFAULT_RAW_SHELF_MONTHS;
        it.updated_at = now(); touched = true;
      }
    }
  } catch {}
  return touched;
}
// compat: الاسم القديم كان يغطي المنتج النهائي فقط
const ensurePrdShelf = ensureShelfDefaults;

const now = () => new Date().toISOString();
const hasText = v => typeof v === 'string' && v.trim().length > 0;
// تطبيع للمطابقة: تقليص المسافات وتوحيد الهمزات (العرض الأصلي محفوظ)
function normSub(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').replace(/[أإآ]/g, 'ا');
}
// إيجاد تصنيف مطابق أو إنشاؤه — الجدول الصامت خلف نموذج المادة
function resolveCategory(d, main, sub, ctx) {
  if (!MAIN_CATS.includes(main)) throw Object.assign(new Error('التصنيف الرئيسي يجب أن يكون: ' + MAIN_CATS.join(' / ')), { code: 400 });
  if (!hasText(sub)) throw Object.assign(new Error('التصنيف الفرعي مطلوب'), { code: 400 });
  const key = normSub(sub);
  let c = d.categories.find(x => x.main === main && normSub(x.sub) === key);
  if (!c) {
    c = { id: d.seq.category++, main, sub: String(sub).trim().replace(/\s+/g, ' '), active: true, created_at: now(), updated_at: now() };
    // كود التصنيف: من صيغة numbering.category (تلقائي دائماً)
    try {
      if (!Number.isInteger(d.seq.category_code) || d.seq.category_code < 1) d.seq.category_code = 1;
      const pat = (((System.get() || {}).numbering) || {}).category || 'CAT-{NNN}';
      const usedCats = new Set((d.categories || []).map(x => String(x.code || '')));
      let ccode = '';
      let guard = 0;
      do {
        const n = d.seq.category_code++;
        ccode = pat.includes('{YYYY}')
          ? pat.replace('{YYYY}', String(new Date().getFullYear())).replace(/\{N+\}/, m => String(n).padStart(m.length - 2, '0'))
          : pat.replace(/\{N+\}/, m => String(n).padStart(m.length - 2, '0'));
        guard++;
      } while (usedCats.has(ccode) && guard < 1000);
      c.code = ccode;
    } catch {}
    d.categories.push(c);
    audit(d, 'add', 'category', c.id, (ctx && ctx.user) || 'system', (ctx && ctx.role) || 'admin');
  }
  return c;
}

// تحويل أرقام متسامح: يقبل الأرقام العربية ٠-٩ والفارسية ٠-۹ والفواصل والمسافات
// يرمي خطأ 400 بدل تخزين NaN/null عند إدخال غير صالح
function toNum(v, field) {
  if (v === null || v === undefined || v === '') return 0;
  let s = String(v).trim();
  if (s === '') return 0;
  s = s.replace(/[٠-٩]/g, ch => '٠١٢٣٤٥٦٧٨٩'.indexOf(ch))
       .replace(/[۰-۹]/g, ch => '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch))
       .replace(/[\s  ']/g, '')
       .replace(/٬/g, '')
       .replace(/[٫,]/g, '.');
  const parts = s.split('.');
  if (parts.length > 2) s = parts.shift() + '.' + parts.join('');
  const n = Number(s);
  if (!Number.isFinite(n)) throw Object.assign(new Error((field || 'الرقم') + ': رقم غير صالح'), { code: 400 });
  return n;
}
// مهلة الخمول بالأيام (تنبيهات الزبائن): عدد صحيح 1-365 — فارغ/غائب = الافتراضي المركزي (النظام ← التنبيهات)
function sysIdleDef() {
  try { return require('./system').tracking().defaultIdleDays; } catch { return 7; }
}
function parseIdleDays(v) {
  if (v === undefined || v === null || String(v).trim() === '') return sysIdleDef();
  const n = Number(String(v).trim()
    .replace(/[٠-٩]/g, ch => '٠١٢٣٤٥٦٧٨٩'.indexOf(ch))
    .replace(/[۰-۹]/g, ch => '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)));
  if (!Number.isInteger(n) || n < 1 || n > 365) throw Object.assign(new Error('مهلة الخمول: عدد صحيح بين 1 و 365 يوماً'), { code: 400 });
  return n;
}
// مدة الصلاحية بالأشهر: عدد صحيح 1-60 — فارغ/غائب = undefined (يُطبق الافتراضي)
function parseShelfMonths(v, field) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const s = String(v).trim()
    .replace(/[٠-٩]/g, ch => '٠١٢٣٤٥٦٧٨٩'.indexOf(ch))
    .replace(/[۰-۹]/g, ch => '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch));
  const n = Number(s);
  if (!Number.isInteger(n) || n < SHELF_MIN || n > SHELF_MAX) throw Object.assign(new Error((field || 'مدة الصلاحية') + ': عدد صحيح بين 1 و 60 شهراً'), { code: 400 });
  return n;
}

// الهاتف: أرقام فقط (فارغ مسموح) — مع تحويل الأرقام العربية والفارسية
function checkPhone(p) {
  let s = String(p || '').trim();
  s = s.replace(/[٠-٩]/g, ch => '٠١٢٣٤٥٦٧٨٩'.indexOf(ch)).replace(/[۰-۹]/g, ch => '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch));
  if (s !== '' && !/^[0-9]+$/.test(s)) throw Object.assign(new Error('الهاتف: أرقام فقط'), { code: 400 });
  return s;
}

// وظائف العمال المقفلة — نفس قائمة تبويب العمال
const WORKER_JOBS = ['مدير', 'مقتصد', 'حارس', 'سائق شاحنة', 'منتج', 'عامل'];
function validJob(j) {
  const s = String(j || '').trim();
  if (!WORKER_JOBS.includes(s)) throw Object.assign(new Error('الوظيفة يجب أن تكون: ' + WORKER_JOBS.join(' / ')), { code: 400 });
  return s;
}

// بطاقة الزبون التجارية — نفس قوائم تبويب الزبائن (صنف + نوع سعر + أرقام جبائية)
// الصنف: تجزئة / جملة / مربي — نوع السعر: تجزئة / جملة — الأرقام الجبائية حرة (فارغ مسموح)
const CUSTOMER_KINDS = ['تجزئة', 'جملة', 'مربي'];
const CUSTOMER_PRICE_TYPES = ['تجزئة', 'جملة'];
function validCustomerKind(k, fallback) {
  const s = String(k === undefined || k === null ? '' : k).trim();
  if (s === '' && fallback !== undefined) return fallback;
  if (!CUSTOMER_KINDS.includes(s)) throw Object.assign(new Error('صنف الزبون يجب أن يكون: ' + CUSTOMER_KINDS.join(' / ')), { code: 400 });
  return s;
}
function validCustomerPrice(p, fallback) {
  const s = String(p === undefined || p === null ? '' : p).trim();
  if (s === '' && fallback !== undefined) return fallback;
  if (!CUSTOMER_PRICE_TYPES.includes(s)) throw Object.assign(new Error('نوع السعر يجب أن يكون: ' + CUSTOMER_PRICE_TYPES.join(' / ')), { code: 400 });
  return s;
}
function fiscalNum(v, label, max) {
  const s = String(v === undefined || v === null ? '' : v).trim().replace(/\s+/g, ' ');
  const m = Number(max) > 0 ? Number(max) : 40;
  if (s.length > m) throw Object.assign(new Error(label + ': ' + m + ' حرفاً على الأكثر'), { code: 400 });
  return s;
}

// ---- الأكواد التلقائية: بادئة ثابتة لكل تبويب + تسلسل لا يُعاد ----
// الأصناف بثلاثة تسلسلات حسب الطبيعة: MAT خام / PRD تام / PAC تغليف
const CODE_CONF = {
  items_mat: { prefix: 'MAT', counter: 'item_code_mat' },
  items_prd: { prefix: 'PRD', counter: 'item_code_prd' },
  items_pac: { prefix: 'PAC', counter: 'item_code_pac' },
  suppliers: { prefix: 'SUP', counter: 'supplier_code' },
  customers: { prefix: 'CUS', counter: 'customer_code' },
  workers: { prefix: 'WRK', counter: 'worker_code' },
  warehouses: { prefix: 'WH', counter: 'warehouse_code' }
};
function itemCodeKey(main) {
  if (main === 'منتج نهائي') return 'items_prd';
  if (main === 'تعبئة وتغليف') return 'items_pac';
  return 'items_mat';
}
function peekCode(d, key) {
  const c = CODE_CONF[key] || { prefix: '', counter: key + '_code' };
  const cfg = codeCfg(key);
  if (cfg.mode === 'manual') return 'يدوي إلزامي';
  if (!Number.isInteger(d.seq[c.counter]) || d.seq[c.counter] < 1) d.seq[c.counter] = 1;
  const n = String(d.seq[c.counter]).padStart(3, '0');
  if (cfg.mode === 'off') return n;
  const prefix = cfg.prefix || c.prefix || '';
  return (prefix ? prefix + '-' : '') + n;
}
function nextCode(d, key, arr, manual) {
  const c = CODE_CONF[key] || { prefix: '', counter: key + '_code' };
  const cfg = codeCfg(key);
  const hasManual = manual !== undefined && manual !== null && String(manual).trim() !== '';
  if (cfg.mode === 'off') {
    if (hasManual) throw Object.assign(new Error('الترميز اليدوي موقف لهذا النوع — اتركه فارغاً'), { code: 400 });
    return genPlain(d, c, arr);
  }
  if (cfg.mode === 'manual' && !hasManual) throw Object.assign(new Error('الكود اليدوي إلزامي لهذا النوع — أدخله (2-24 حرفاً)'), { code: 400 });
  if (hasManual) return validManualCode(manual, arr, 'الكود');
  return genAuto(d, c, arr, cfg.prefix || c.prefix || '');
}
function genPlain(d, c, arr) {
  if (!Number.isInteger(d.seq[c.counter]) || d.seq[c.counter] < 1) d.seq[c.counter] = 1;
  const used = new Set((arr || []).map(x => String(x.code || '')));
  let code;
  do { code = String(d.seq[c.counter]++).padStart(3, '0'); } while (used.has(code));
  return code;
}
function genAuto(d, c, arr, prefix) {
  if (!Number.isInteger(d.seq[c.counter]) || d.seq[c.counter] < 1) d.seq[c.counter] = 1;
  const used = new Set((arr || []).map(x => String(x.code || '')));
  let code;
  do { code = (prefix ? prefix + '-' : '') + String(d.seq[c.counter]++).padStart(3, '0'); } while (used.has(code));
  return code;
}
// نمط الترميز من الإعدادات (تبويب أكواد العناصر): auto هجين / manual إلزامي / off أرقام
function codeCfg(key) {
  try {
    const sys = System.get();
    const cm = (sys.codemode || {})[key];
    if (cm && typeof cm === 'object') {
      return {
        mode: ['auto', 'manual', 'off'].includes(cm.mode) ? cm.mode : 'auto',
        prefix: typeof cm.prefix === 'string' ? cm.prefix : ''
      };
    }
  } catch {}
  const c = CODE_CONF[key] || {};
  return { mode: 'auto', prefix: c.prefix || '' };
}
// ---- الأنماط المخصصة (يضيفها المدير من تبويب الأكواد: فاتورة/وصل/عملية...)
// تعريف النمط من الإعدادات + عدّاد مستقل لكل مفتاح + سجل إصدار يمنع التكرار
function customDef(key) {
  try {
    const sys = System.get();
    const cu = ((sys.codemode || {}).custom) || {};
    const e = cu[key];
    if (e && typeof e === 'object' && typeof e.label === 'string' && ['auto', 'manual', 'off'].includes(e.mode)) {
      return { label: e.label, mode: e.mode, prefix: typeof e.prefix === 'string' ? e.prefix : '' };
    }
  } catch {}
  return null;
}
function customCounter(key) { return 'customcode_' + key; }
function customUsed(d, key) {
  const log = ((d.custom_codes || {})[key]) || [];
  return new Set(log.map(x => String((x && x.code) || '')));
}
function peekCustom(d, key) {
  const def = customDef(key);
  if (!def) throw Object.assign(new Error('نمط ترميز غير معرف: ' + key), { code: 404 });
  if (def.mode === 'manual') return 'يدوي إلزامي';
  const ctr = customCounter(key);
  if (!Number.isInteger(d.seq[ctr]) || d.seq[ctr] < 1) d.seq[ctr] = 1;
  const n = String(d.seq[ctr]).padStart(3, '0');
  if (def.mode === 'off') return n;
  return ((def.prefix || '') ? def.prefix + '-' : '') + n;
}
function mintCustom(d, key, manual, ctx) {
  const def = customDef(key);
  if (!def) throw Object.assign(new Error('نمط ترميز غير معرف: ' + key), { code: 404 });
  const hasManual = manual !== undefined && manual !== null && String(manual).trim() !== '';
  if (def.mode === 'off' && hasManual) throw Object.assign(new Error('الترميز اليدوي موقف لهذا النمط — اتركه فارغاً'), { code: 400 });
  if (def.mode === 'manual' && !hasManual) throw Object.assign(new Error('الكود اليدوي إلزامي لهذا النمط — أدخله (2-24 حرفاً)'), { code: 400 });
  const used = customUsed(d, key);
  let code;
  if (hasManual) {
    code = validManualCode(manual, Array.from(used).map(c => ({ code: c })), 'الكود');
  } else {
    const ctr = customCounter(key);
    if (!Number.isInteger(d.seq[ctr]) || d.seq[ctr] < 1) d.seq[ctr] = 1;
    const pfx = def.mode === 'off' ? '' : (def.prefix || '');
    do { code = (pfx ? pfx + '-' : '') + String(d.seq[ctr]++).padStart(3, '0'); } while (used.has(code));
  }
  d.custom_codes = d.custom_codes || {};
  d.custom_codes[key] = d.custom_codes[key] || [];
  d.custom_codes[key].push({ code, at: now(), by: (ctx && ctx.user) || 'system' });
  if (d.custom_codes[key].length > 2000) d.custom_codes[key] = d.custom_codes[key].slice(-2000);
  return code;
}
function validManualCode(code, arr, label) {
  const s = String(code == null ? '' : code).trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 24) throw Object.assign(new Error((label || 'الكود') + ': 2-24 حرفاً'), { code: 400 });
  if (!/^[\p{L}0-9][\p{L}0-9\-_./ ]*$/u.test(s)) throw Object.assign(new Error((label || 'الكود') + ': حروف/أرقام و - _ . / فقط'), { code: 400 });
  const low = s.toLowerCase();
  if ((arr || []).some(x => String(x.code || '').trim().toLowerCase() === low)) throw Object.assign(new Error((label || 'الكود') + ' مستعمل: ' + s), { code: 400 });
  return s;
}
const r2m = n => Math.round(Number(n || 0) * 100) / 100;
// تغيير الوحدة أو الطبيعة (التصنيف الرئيسي) بعد دخول المخزون يفسد كل السجلات —
// ممنوع عند وجود رصيد متبقٍّ أو أي حركة مسجلة (الحل: صنف جديد + تصفير القديم بالبيع/التحويل)
function assertNoStock(itemId, label) {
  try {
    const inv = require('./jstore')('inventory.json', { lots: [], movements: [] }).load();
    const rem = (inv.lots || []).filter(l => Number(l.item_id) === Number(itemId))
      .reduce((s, l) => s + Number(l.remaining || 0), 0);
    if (r2m(rem) > 0) throw Object.assign(new Error(label + ': للمادة رصيد ' + r2m(rem) + ' في المخزون — صفّره أولاً'), { code: 400 });
    if ((inv.movements || []).some(m => Number(m.item_id) === Number(itemId))) {
      throw Object.assign(new Error(label + ': للمادة حركات مسجلة — التغيير بعد الحركة يفسد وحدة القياس في السجلات (أنشئ صنفاً جديداً)'), { code: 400 });
    }
  } catch (e) { if (e && e.code === 400) throw e; }
}
// رصيد افتتاحي للصنف (مرة واحدة ويقفل): لوت افتتاحي حقيقي يدخل المخزون
// المخزن: اختيار صريح من الواجهة (warehouse_id) أو تلقائي —
// الخام والتغليف ← أول مخزن مواد أولية — المنتج التام ← أول مخزن منتج نهائي
function createItemOpeningLot(d, item, qty, cost, ctx, warehouse_id) {
  const cat = (d.categories || []).find(c => c.id === Number(item.category_id)) || {};
  let wh = null;
  if (warehouse_id !== undefined && warehouse_id !== null && String(warehouse_id).trim() !== '') {
    wh = (d.warehouses || []).find(w => Number(w.id) === Number(warehouse_id));
    if (!wh) throw Object.assign(new Error('المخزن المختار غير موجود'), { code: 400 });
  } else {
    const wantType = cat.main === 'منتج نهائي' ? 'منتج نهائي' : 'مواد أولية';
    wh = (d.warehouses || []).find(w => w.type === wantType);
    if (!wh) throw Object.assign(new Error('عرّف مخزن «' + wantType + '» أولاً'), { code: 400 });
  }
  const Stock = require('./stock');
  const lot = Stock.receiveLot({
    item_id: item.id, item_name: item.name, unit: item.unit,
    qty: r2m(qty), cost: r2m(cost),
    warehouse_id: wh.id, warehouse_name: wh.name,
    expiry: '', qc: 'مقبولة', order_num: 'افتتاحي', supplier_name: '',
    date: now().slice(0, 10), user: (ctx && ctx.user) || 'system'
  });
  item.opening_qty = r2m(qty); item.opening_cost = r2m(cost); item.opening_locked = true;
  item.opening_warehouse_id = wh.id; item.opening_warehouse_name = wh.name;
  d.opening_log.push({
    id: d.seq.opening++, entity: 'item', ref_id: item.id, ref_name: item.name,
    amount: r2m(qty), extra: 'تكلفة ' + r2m(cost), date: now(),
    note: 'رصيد افتتاحي صنف (' + wh.name + ')'
  });
  return lot;
}

function audit(d, action, entity, ref_id, by, role) {
  d.audit.push({ id: d.seq.audit++, action, entity, ref_id, by: by || 'admin', role: role || 'admin', at: now() });
  if (d.audit.length > 500) d.audit = d.audit.slice(-500);
}
function lastMod(d) {
  if (!d.audit.length) return null;
  const a = d.audit[d.audit.length - 1];
  return a.at;
}

// ترتيب الإدخال الإلزامي: تصنيفات ← مواد ← (موردون/زبائن/عمال) ← مخازن
function orderStatus(d) {
  return {
    hasCategories: d.categories.length > 0,
    hasItems: d.items.length > 0,
    hasPartners: (d.suppliers.length + d.customers.length + d.workers.length) > 0,
    hasWarehouses: d.warehouses.length >= 2
  };
}

const Master = {
  UNITS,
  MAIN_CATS,
  DEFAULT_PRD_SHELF_MONTHS,
  DEFAULT_RAW_SHELF_MONTHS,

  kpi() {
    const d = store.load();
    const pick = (arr) => (arr.length ? arr[arr.length - 1] : null);
    const ls = pick(d.suppliers), lc = pick(d.customers), li = pick(d.items);
    return {
      data: {
        last_supplier: ls ? { id: ls.id, name: ls.name, at: ls.created_at } : null,
        last_customer: lc ? { id: lc.id, name: lc.name, at: lc.created_at } : null,
        last_item: li ? { id: li.id, name: li.name, code: li.code, at: li.created_at } : null,
        last_mod: lastMod(d),
        totals: {
          items_active: d.items.filter(x => x.status === 'نشطة').length,
          suppliers_active: d.suppliers.filter(x => x.active !== false).length,
          customers_active: d.customers.filter(x => x.active !== false).length
        },
        order: orderStatus(d)
      }
    };
  },

  list(name) {
    const d = store.load();
    if (name === 'items') {
      let touched = ensurePrdShelf(d);
      // ترحيل صامت: بطاقات قديمة برصيد افتتاحي بلا مخزن مسجل ← يُستنتج من لوتها الافتتاحي
      try {
        const needy = (d.items || []).filter(it => Number(it.opening_qty || 0) > 0 && !it.opening_warehouse_name);
        if (needy.length) {
          const inv = require('./jstore')('inventory.json', { lots: [] }).load();
          const olots = (inv.lots || []).filter(l => String(l.order_num || '') === 'افتتاحي');
          for (const it of needy) {
            const lot = olots.find(l => Number(l.item_id) === Number(it.id));
            if (lot) {
              it.opening_warehouse_id = lot.warehouse_id;
              it.opening_warehouse_name = lot.warehouse_name || '';
              it.updated_at = now(); touched = true;
            }
          }
        }
      } catch {}
      if (touched) { try { store.save(d); } catch {} }
    }
    return { data: d[name] || [] };
  },

  // الأكواد القادمة للنماذج (معاينة بلا حجز) + ترميم ذاتي لأي سجل قديم بلا كود
  // الأصناف بثلاث معاينات حسب الطبيعة (MAT/PRD/PAC) — الترميم يمنح كل صنف قديم كود طبيعته
  codes() {
    const d = store.load();
    let touched = false;
    // الترميم الذاتي دائماً بالنمط التلقائي (يتجاوز manual/off حتى لا ينكسر العرض)
    for (const r of (d.items || [])) {
      if (!r.code) {
        const cm = ((d.categories || []).find(c => c.id === Number(r.category_id)) || {}).main;
        const kk = itemCodeKey(cm);
        const cc = CODE_CONF[kk] || {};
        r.code = genAuto(d, cc, d.items, cc.prefix || '');
        touched = true;
      }
    }
    for (const [key, arr] of [['suppliers', 'suppliers'], ['customers', 'customers'], ['workers', 'workers'], ['warehouses', 'warehouses']]) {
      for (const r of (d[arr] || [])) {
        if (!r.code) { const cc = CODE_CONF[key] || {}; r.code = genAuto(d, cc, d[arr], cc.prefix || ''); touched = true; }
      }
    }
    for (const r of (d.categories || [])) {
      if (!r.code) {
        if (!Number.isInteger(d.seq.category_code) || d.seq.category_code < 1) d.seq.category_code = 1;
        const usedCats = new Set((d.categories || []).map(x => String(x.code || '')));
        let ccode = '';
        let guard = 0;
        do {
          ccode = 'CAT-' + String(d.seq.category_code++).padStart(3, '0');
          guard++;
        } while (usedCats.has(ccode) && guard < 1000);
        r.code = ccode;
        touched = true;
      }
    }
    if (touched) store.save(d);
    let modes = {};
    try {
      const sys = System.get();
      modes = sys.codemode || {};
    } catch {}
    return {
      data: {
        items: { MAT: peekCode(d, 'items_mat'), PRD: peekCode(d, 'items_prd'), PAC: peekCode(d, 'items_pac') },
        suppliers: peekCode(d, 'suppliers'),
        customers: peekCode(d, 'customers'), workers: peekCode(d, 'workers'),
        warehouses: peekCode(d, 'warehouses'),
        modes,
        // الأنماط المخصصة: تعريف + الكود التالي (معاينة) + عدد المصدر
        custom: Object.keys(((modes || {}).custom) || {}).map(k => {
          const e = modes.custom[k] || {};
          let next = '';
          try { next = peekCustom(d, k); } catch { next = '—'; }
          return {
            key: k, label: e.label || k,
            mode: e.mode || 'auto', prefix: e.prefix || '',
            next, issued: (((d.custom_codes || {})[k]) || []).length
          };
        })
      }
    };
  },

  // إصدار كود من نمط مخصص (فاتورة/وصل/عملية...): يحجز التسلسل ويسجله لمنع التكرار
  mintCustom(b, ctx) {
    if (!Auth.can(ctx.role, 'master', 'party')) throw Object.assign(new Error('صلاحية إصدار الأكواد: مدير المخزون أو المدير العام فقط'), { code: 403 });
    const key = String((b || {}).key || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{2,24}$/.test(key)) throw Object.assign(new Error('مفتاح النمط غير صالح'), { code: 400 });
    const d = store.load();
    const code = mintCustom(d, key, (b || {}).code, ctx);
    audit(d, 'mint', 'customcode:' + key, 0, ctx.user, ctx.role);
    store.save(d);
    return { data: { key, code } };
  },

  // ---- تصنيفات ----
  addCategory(b, ctx) {
    if (!Auth.can(ctx.role, 'master', 'item')) throw Object.assign(new Error('صلاحية بطاقة المادة والتصنيفات: مدير المخزون أو المدير العام فقط'), { code: 403 });
    if (!MAIN_CATS.includes(b.main)) throw Object.assign(new Error('التصنيف الرئيسي يجب أن يكون: ' + MAIN_CATS.join(' / ')), { code: 400 });
    if (!hasText(b.sub)) throw Object.assign(new Error('التصنيف الفرعي مطلوب'), { code: 400 });
    const d = store.load();
    if (d.categories.some(c => c.main === b.main && c.sub.trim() === b.sub.trim())) throw Object.assign(new Error('هذا التصنيف موجود مسبقاً'), { code: 400 });
    const row = { id: d.seq.category++, main: b.main, sub: b.sub.trim(), active: true, created_at: now(), updated_at: now() };
    d.categories.push(row);
    audit(d, 'add', 'category', row.id, ctx.user, ctx.role);
    store.save(d);
    return { data: row };
  },
  updateCategory(id, b, ctx) {
    if (!Auth.can(ctx.role, 'master', 'item')) throw Object.assign(new Error('صلاحية التصنيفات: مدير المخزون أو المدير العام فقط'), { code: 403 });
    const d = store.load();
    const r = d.categories.find(x => x.id === id);
    if (!r) throw Object.assign(new Error('التصنيف غير موجود'), { code: 404 });
    if (b.main && !MAIN_CATS.includes(b.main)) throw Object.assign(new Error('تصنيف رئيسي غير صالح'), { code: 400 });
    if (b.main) r.main = b.main;
    if (b.sub !== undefined) { if (!hasText(b.sub)) throw Object.assign(new Error('التصنيف الفرعي مطلوب'), { code: 400 }); r.sub = b.sub.trim(); }
    r.updated_at = now();
    audit(d, 'update', 'category', id, ctx.user, ctx.role);
    store.save(d);
    return { data: r };
  },
  deleteCategory(id, ctx) {
    if (!Auth.can(ctx.role, 'master', 'item')) throw Object.assign(new Error('صلاحية التصنيفات: مدير المخزون أو المدير العام فقط'), { code: 403 });
    const d = store.load();
    if (d.items.some(i => i.category_id === id)) throw Object.assign(new Error('ممنوع الحذف: توجد مواد مرتبطة بهذا التصنيف'), { code: 400 });
    const i = d.categories.findIndex(x => x.id === id);
    if (i < 0) throw Object.assign(new Error('التصنيف غير موجود'), { code: 404 });
    d.categories.splice(i, 1);
    audit(d, 'delete', 'category', id, ctx.user, ctx.role);
    store.save(d);
    return { ok: true };
  },

  // ---- مواد أولية ----
  addItem(b, ctx) {
    if (!Auth.can(ctx.role, 'master', 'item')) throw Object.assign(new Error('صلاحية بطاقة المادة: مدير المخزون أو المدير العام فقط'), { code: 403 });
    const d = store.load();
    if (!hasText(b.name)) throw Object.assign(new Error('اسم المادة مطلوب'), { code: 400 });
    // الاسم فريد: التكرار يصنع بطاقتين لصنف واحد فيتشتت المخزون بينهما
    if (d.items.some(i => i.name.trim() === b.name.trim())) throw Object.assign(new Error('الاسم مستعمل («' + b.name.trim() + '») — عدّل البطاقة الموجودة بدل التكرار'), { code: 400 });
    if (!UNITS.includes(b.unit)) throw Object.assign(new Error('الوحدة يجب أن تكون: ' + UNITS.join(' / ')), { code: 400 });
    let catId;
    if (b.category_id !== undefined && b.category_id !== '' && b.category_id !== null) {
      if (!d.categories.some(c => c.id === Number(b.category_id))) throw Object.assign(new Error('التصنيف غير موجود'), { code: 400 });
      catId = Number(b.category_id);
    } else {
      if (b.cat_main === undefined) throw Object.assign(new Error('التصنيف مطلوب (رئيسي + فرعي)'), { code: 400 });
      catId = resolveCategory(d, b.cat_main, b.cat_sub, ctx).id;
    }
    const catMain = (d.categories.find(c => c.id === catId) || {}).main;
    // المنتج النهائي لا يُشترى: آخر سعر شراء صفر إجباري (تكلفته من الإنتاج)
    const lp = catMain === 'منتج نهائي' ? 0 : toNum(b.last_price, 'آخر سعر شراء');
    const row = {
      id: d.seq.item++, code: nextCode(d, itemCodeKey(catMain), d.items, b.code), name: b.name.trim(),
      category_id: catId, unit: b.unit,
      min_stock: toNum(b.min_stock, 'الحد الأدنى'), last_price: lp,
      image: checkItemImage(b.image) || '',
      status: b.status === 'متوقفة' ? 'متوقفة' : 'نشطة', price_updated_at: now(),
      created_at: now(), updated_at: now()
    };
    // صورة الصنف (data URL مضغوطة من المتصفح — حد 300KB ليناسب حد الطلب)
function checkItemImage(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  if (s.length > 300000) throw Object.assign(new Error('الصورة كبيرة (الحد 300KB) — اختر أصغر'), { code: 400 });
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) throw Object.assign(new Error('الصورة بصيغة data URL فقط (PNG/JPG/WEBP)'), { code: 400 });
  return s;
}
// مدة الصلاحية: منتج نهائي → 3 أشهر تلقائياً دون إدخال؛
    // مواد أولية → القيمة المدخلة من البطاقة أو 3 أشهر تلقائياً؛ تغليف → المدخلة فقط
    if (catMain === 'منتج نهائي') row.shelf_months = DEFAULT_PRD_SHELF_MONTHS;
    else if (catMain === 'مواد أولية') {
      const sm = parseShelfMonths(b.shelf_months, 'مدة الصلاحية');
      row.shelf_months = sm === undefined ? DEFAULT_RAW_SHELF_MONTHS : sm;
    } else {
      const sm = parseShelfMonths(b.shelf_months, 'مدة الصلاحية');
      if (sm !== undefined) row.shelf_months = sm;
    }
    d.items.push(row);
    // الرصيد الافتتاحي (خام أو تام): لوت حقيقي مرة واحدة — التكلفة من الحقل أو آخر سعر
    const oq = toNum(b.opening_qty, 'الرصيد الافتتاحي');
    if (oq > 0) {
      const oc = (b.opening_cost === undefined || b.opening_cost === null || b.opening_cost === '')
        ? Number(lp || 0) : toNum(b.opening_cost, 'تكلفة الافتتاح');
      // تكلفة الصفر تُنتج مخزوناً بلا قيمة وتسمم كل التكاليف اللاحقة — ممنوعة
      if (!(oc > 0)) throw Object.assign(new Error('أدخل تكلفة الافتتاح للوحدة (أكبر من صفر) — الصفر يخفي القيمة الحقيقية'), { code: 400 });
      createItemOpeningLot(d, row, oq, oc, ctx, b.warehouse_id);
    }
    audit(d, 'add', 'item', row.id, ctx.user, ctx.role);
    store.save(d);
    return { data: row };
  },
  updateItem(id, b, ctx) {
    if (!Auth.can(ctx.role, 'master', 'item')) throw Object.assign(new Error('بطاقة المادة للمدير العام فقط'), { code: 403 });
    const d = store.load();
    const r = d.items.find(x => x.id === id);
    if (!r) throw Object.assign(new Error('المادة غير موجودة'), { code: 404 });
    // الكود تلقائي ثابت: أي كود مرسل يُتجاهل
    if (b.code !== undefined) delete b.code;
    if (b.name !== undefined) { if (!hasText(b.name)) throw Object.assign(new Error('اسم المادة مطلوب'), { code: 400 }); if (d.items.some(i => i.id !== r.id && i.name.trim() === b.name.trim())) throw Object.assign(new Error('الاسم مستعمل في بطاقة أخرى — التكرار يشتت المخزون'), { code: 400 }); r.name = b.name.trim();
      // انتشار الاسم الجديد على المخزون الحي (لوتات + حركات) — سجلات البيع/الشراء التاريخية لا تُمس
      try {
        const invDb = require('./jstore')('inventory.json', { lots: [], movements: [] });
        const id = invDb.load();
        let touched = false;
        for (const l of (id.lots || [])) {
          if (Number(l.item_id) === Number(r.id) && l.item_name !== r.name) { l.item_name = r.name; touched = true; }
        }
        for (const m of (id.movements || [])) {
          if (Number(m.item_id) === Number(r.id) && m.item_name !== r.name) { m.item_name = r.name; touched = true; }
        }
        if (touched) invDb.save(id);
      } catch {} }
    const oldMain = ((d.categories || []).find(c => c.id === Number(r.category_id)) || {}).main;
    if (b.category_id !== undefined && b.category_id !== '' && b.category_id !== null) {
      if (!d.categories.some(c => c.id === Number(b.category_id))) throw Object.assign(new Error('التصنيف غير موجود'), { code: 400 });
      const newMain = ((d.categories || []).find(c => c.id === Number(b.category_id)) || {}).main;
      if ((newMain || '') !== (oldMain || '')) assertNoStock(r.id, 'التصنيف الرئيسي (' + (oldMain || '?') + ' ← ' + (newMain || '?') + ')');
      r.category_id = Number(b.category_id);
    } else if (b.cat_main !== undefined) {
      if (b.cat_main !== oldMain) assertNoStock(r.id, 'التصنيف الرئيسي (' + (oldMain || '?') + ' ← ' + b.cat_main + ')');
      r.category_id = resolveCategory(d, b.cat_main, b.cat_sub, ctx).id;
    }
    if (b.unit !== undefined && b.unit !== r.unit) {
      if (!UNITS.includes(b.unit)) throw Object.assign(new Error('وحدة غير صالحة'), { code: 400 });
      assertNoStock(r.id, 'وحدة القياس (' + r.unit + ' ← ' + b.unit + ')');
      r.unit = b.unit;
    }
    if (b.min_stock !== undefined) r.min_stock = toNum(b.min_stock, 'الحد الأدنى');
    if (b.last_price !== undefined) {
      const np = toNum(b.last_price, 'آخر سعر شراء');
      if (np !== Number(r.last_price || 0)) r.price_updated_at = now();
      r.last_price = np;
    }
    if (b.status !== undefined) r.status = b.status === 'متوقفة' ? 'متوقفة' : 'نشطة';
    if (b.image !== undefined) {
      const img = checkItemImage(b.image);
      if (img === undefined) delete r.image; else r.image = img;
    }
    r.updated_at = now();
    // المنتج النهائي لا يُشترى: أي سعر مدخل يُصفّر (تكلفته من الإنتاج)
    const fcat = (d.categories || []).find(c => c.id === Number(r.category_id));
    if (fcat && fcat.main === 'منتج نهائي' && Number(r.last_price || 0) !== 0) { r.last_price = 0; r.price_updated_at = now(); }
    // مدة الصلاحية قابلة للتعديل من البطاقة (1-60 شهراً)
    if (b.shelf_months !== undefined && b.shelf_months !== null && String(b.shelf_months).trim() !== '') {
      r.shelf_months = parseShelfMonths(b.shelf_months, 'مدة الصلاحية');
    }
    // صلاحية تلقائية: أي منتج نهائي أو مادة أولية بلا مدة صالحة → 3 أشهر (ترحيل صامت للقديم)
    if (fcat && (fcat.main === 'منتج نهائي' || fcat.main === 'مواد أولية')) {
      const v = Number(r.shelf_months);
      if (!Number.isFinite(v) || v <= 0) r.shelf_months = fcat.main === 'منتج نهائي' ? DEFAULT_PRD_SHELF_MONTHS : DEFAULT_RAW_SHELF_MONTHS;
    }
    // الرصيد الافتتاحي: يُدخل مرة واحدة فقط — أي تغيير لاحق مرفوض (التصحيح بالجرد)
    if (b.opening_qty !== undefined || b.opening_cost !== undefined) {
      const nq = b.opening_qty !== undefined ? toNum(b.opening_qty, 'الرصيد الافتتاحي') : Number(r.opening_qty || 0);
      const nc = (b.opening_cost !== undefined && b.opening_cost !== null && b.opening_cost !== '')
        ? toNum(b.opening_cost, 'تكلفة الافتتاح') : Number(r.opening_cost ?? r.last_price ?? 0);
      if (r.opening_locked) {
        if (r2m(nq) !== r2m(Number(r.opening_qty || 0)) || r2m(nc) !== r2m(Number(r.opening_cost || 0))) {
          // تصحيح المدير: هذه البوابة (master.item) لا يمر منها إلا المدير العام ومدير المخزون —
          // يُضبط اللوت الافتتاحي بأثر رجعي مع حماية الكمية المستهلكة، ويُسجل في التدقيق
          if (!(nq > 0)) throw Object.assign(new Error('التصحيح: الكمية الجديدة أكبر من صفر'), { code: 400 });
          if (!(nc > 0)) throw Object.assign(new Error('التصحيح: التكلفة الجديدة أكبر من صفر'), { code: 400 });
          const invDb = require('./jstore')('inventory.json', { seq: { lot: 1, lot_num: 1, mov: 1 }, lots: [], movements: [] });
          const inv = invDb.load();
          const olots = (inv.lots || []).filter(l => Number(l.item_id) === Number(r.id) && String(l.order_num || '') === 'افتتاحي');
          if (!olots.length) throw Object.assign(new Error('لا لوت افتتاحي مرتبط بهذا الصنف — صحح بالجرد'), { code: 400 });
          if (olots.length > 1) throw Object.assign(new Error('عدة لوتات افتتاحية مرتبطة — صحح بالجرد'), { code: 400 });
          const lot = olots[0];
          const consumed = r2m(Number(lot.qty || 0) - Number(lot.remaining || 0));
          if (consumed < 0) throw Object.assign(new Error('بيانات اللوت غير متسقة — راجع المخزون قبل التصحيح'), { code: 400 });
          const newRem = r2m(nq - consumed);
          if (newRem < 0) throw Object.assign(new Error('التخفيض يتجاوز الكمية المستهلكة فعلاً (' + consumed + ' ' + r.unit + ') — استعمل الجرد أو التالف'), { code: 400 });
          const oldQ = r2m(Number(r.opening_qty || 0)), oldC = r2m(Number(r.opening_cost || 0));
          lot.qty = r2m(nq); lot.remaining = newRem; lot.cost_per_unit = r2m(nc);
          const mv = (inv.movements || []).find(m => m.type === 'دخول' && Number(m.lot_id) === Number(lot.id));
          if (mv) mv.qty = r2m(nq);
          invDb.save(inv);
          r.opening_qty = r2m(nq); r.opening_cost = r2m(nc);
          const olog = (d.opening_log || []).find(o => o.entity === 'item' && Number(o.ref_id) === Number(r.id));
          if (olog) { olog.amount = r2m(nq); olog.extra = 'تكلفة ' + r2m(nc); olog.note = (olog.note || '') + ' (تصحيح مدير)'; }
          audit(d, 'opening_fix', 'item', r.id, ctx.user, ctx.role + ' (' + oldQ + '→' + r2m(nq) + '، ' + oldC + '→' + r2m(nc) + ')');
        }
      } else if (nq > 0) {
        if (!(nc > 0)) throw Object.assign(new Error('أدخل تكلفة الافتتاح للوحدة (أكبر من صفر) — الصفر يخفي القيمة الحقيقية'), { code: 400 });
        createItemOpeningLot(d, r, nq, nc, ctx, b.warehouse_id);
      }
    }
    audit(d, 'update', 'item', id, ctx.user, ctx.role);
    store.save(d);
    return { data: r };
  },
  deleteItem(id, ctx) {
    if (!Auth.can(ctx.role, 'master', 'item')) throw Object.assign(new Error('صلاحية بطاقة المادة: مدير المخزون أو المدير العام فقط'), { code: 403 });
    const d = store.load();
    const i = d.items.findIndex(x => x.id === id);
    if (i < 0) throw Object.assign(new Error('المادة غير موجودة'), { code: 404 });
    // قاعدة: لا حذف لمادة لها رصيد/حركة مرتبطة — سجل الأرصدة أو أي لوت بمتبقٍّ
    const linked = d.opening_log.some(o => o.entity === 'item' && o.ref_id === id);
    if (linked) throw Object.assign(new Error('ممنوع الحذف: للمادة رصيد أو حركة مرتبطة — أوقفها بدل الحذف'), { code: 400 });
    try {
      const inv = require('./jstore')('inventory.json', { lots: [] }).load();
      const rem = (inv.lots || []).filter(l => Number(l.item_id) === Number(id)).reduce((s, l) => s + Number(l.remaining || 0), 0);
      if (rem > 0) throw Object.assign(new Error('ممنوع الحذف: للمادة رصيد ' + rem + ' في المخزون — صفّره أولاً'), { code: 400 });
    } catch (e) { if (e && e.code === 400) throw e; }
    d.items.splice(i, 1);
    audit(d, 'delete', 'item', id, ctx.user, ctx.role);
    store.save(d);
    return { ok: true };
  },

  // ---- جهات: موردون/زبائن/عمال (الرصيد الافتتاحي مرة واحدة ويقفل + كود تلقائي) ----
  _addParty(col, logEntity, b, ctx) {
    const d = store.load();
    if (!hasText(b.name)) throw Object.assign(new Error('الاسم مطلوب'), { code: 400 });
    // منع التكرار: الاسم موجود في الجدول — أدخل اسماً مغايراً
    const dupLabel = col === 'suppliers' ? 'المورد' : col === 'customers' ? 'الزبون' : 'العامل';
    if (d[col].some(x => String(x.name || '').trim() === String(b.name).trim())) {
      throw Object.assign(new Error('هذا الاسم مستعمل («' + String(b.name).trim() + '») — أدخل اسماً مغايراً أو عدّل بطاقة ' + dupLabel + ' الموجودة'), { code: 400 });
    }
    const openField = col === 'workers' ? 'opening_balance' : 'opening_debt';
    const codeKey = col === 'suppliers' ? 'suppliers' : col === 'customers' ? 'customers' : 'workers';
    const phone = checkPhone(b.phone);
    // هاتف الزبون إجباري (للتحصيل الميداني) — المورد/العامل اختياري كما كان
    if (col === 'customers') {
      if (!phone) throw Object.assign(new Error('هاتف الزبون إجباري (للتحصيل الميداني)'), { code: 400 });
      if (phone.length < 9 || phone.length > 15) throw Object.assign(new Error('الهاتف: 9-15 رقماً'), { code: 400 });
    }
    const row = {
      id: d.seq[col === 'suppliers' ? 'supplier' : col === 'customers' ? 'customer' : 'worker']++,
      code: nextCode(d, codeKey, d[col], b.code),
      name: b.name.trim(), phone, address: (b.address || '').trim(),
      active: true, created_at: now(), updated_at: now()
    };
    if (col === 'workers') {
      row.opening_balance = toNum(b.opening_balance, 'الرصيد الافتتاحي');
      row.opening_type = b.opening_type === 'سلفة على العامل' ? 'سلفة على العامل' : 'مستحق للعامل';
      row.job = (b.job === undefined || b.job === '') ? 'عامل' : validJob(b.job);
    } else {
      row.opening_debt = toNum(b.opening_debt, 'الدين الافتتاحي');
    }
    if (col === 'customers' || col === 'suppliers') {
      // البطاقة التجارية: أرقام جبائية اختيارية (للزبان: صنف + نوع سعر افتراضي تجزئة)
      // المورد: بلا صنف/نوع سعر/بطاقة مربي — الاسم والهاتف والجبائي والبنك فقط
      // المورد يضاف له البنك (اسم البنك / رقم الحساب / RIB حتى 60 حرفاً)
      if (col === 'customers') {
        row.kind = validCustomerKind(b.kind, 'تجزئة');
        row.price_type = validCustomerPrice(b.price_type, 'تجزئة');
        row.breeder_card = fiscalNum(b.breeder_card, 'بطاقة المربي/الفلاح');
        // سقف الدين: 0 = بلا سقف — التجاوز يُنبَّه عليه أحمر في كل الشاشات
        row.debt_limit = Math.max(0, toNum(b.debt_limit, 'سقف الدين'));
        // مهلة الخمول: افتراضي 7 أيام (للتنبيه الأصفر/الأحمر في المرحلة 2)
        row.idle_days = parseIdleDays(b.idle_days);
      }
      row.rc = fiscalNum(b.rc, 'R.C');
      row.mf = fiscalNum(b.mf, 'M.F');
      row.art_imp = fiscalNum(b.art_imp, 'Art IMP');
      row.nis = fiscalNum(b.nis, 'N.I.S');
      if (col === 'suppliers') row.bank = fiscalNum(b.bank, 'البنك', 60);
    }
    row.opening_locked = true; // يقفل فور الإدخال
    d[col].push(row);
    const amt = col === 'workers' ? row.opening_balance : row.opening_debt;
    if (amt) {
      d.opening_log.push({
        id: d.seq.opening++, entity: logEntity, ref_id: row.id, ref_name: row.name,
        amount: amt, extra: row.opening_type || '', date: now(),
        note: 'رصيد افتتاحي من ' + (col === 'suppliers' ? 'الموردين' : col === 'customers' ? 'الزبائن' : 'العمال')
      });
    }
    audit(d, 'add', col.slice(0, -1), row.id, ctx.user, ctx.role);
    store.save(d);
    return { data: row };
  },
  addSupplier: (b, ctx) => Master._addParty('suppliers', 'supplier', b, ctx),
  addCustomer: (b, ctx) => Master._addParty('customers', 'customer', b, ctx),
  addWorker: (b, ctx) => Master._addParty('workers', 'worker', b, ctx),

  _updateParty(col, id, b, ctx) {
    const d = store.load();
    const r = d[col].find(x => x.id === id);
    if (!r) throw Object.assign(new Error('غير موجود'), { code: 404 });
    // الرصيد الافتتاحي مقفل — أي محاولة تعديله مرفوضة هنا (مقارنة آمنة ضد NaN)
    // الاستثناء: تصحيح المدير (المدير العام / مدير المخزون) — المحاسب يمر من بوابة المسار لكنه مرفوض هنا صراحة
    const openField = col === 'workers' ? 'opening_balance' : 'opening_debt';
    const logEntity = col === 'suppliers' ? 'supplier' : col === 'customers' ? 'customer' : 'worker';
    const isManager = ctx.role === 'admin' || ctx.role === 'storekeeper';
    if (b[openField] !== undefined) {
      let nb = 0, same = false;
      try { nb = toNum(b[openField], 'الرصيد'); same = (nb === toNum(r[openField] ?? 0, 'الرصيد')); } catch { same = false; }
      if (!same) {
        if (!isManager) throw Object.assign(new Error('الرصيد الافتتاحي مقفل بعد الإدخال — التصحيح للمدير العام أو مدير المخزون فقط'), { code: 403 });
        const fixed = toNum(b[openField], 'الرصيد'); // يعيد الرمي عند القيمة غير الصالحة بدل التصفير
        const oldV = toNum(r[openField] ?? 0, 'الرصيد');
        r[openField] = fixed;
        const olog = (d.opening_log || []).find(o => o.entity === logEntity && Number(o.ref_id) === Number(r.id));
        if (olog) { olog.amount = fixed; olog.note = (olog.note || '') + ' (تصحيح مدير)'; }
        audit(d, 'opening_fix', col.slice(0, -1), r.id, ctx.user, ctx.role + ' (' + oldV + '→' + fixed + ')');
      }
    }
    if (col === 'workers' && b.opening_type !== undefined && b.opening_type !== r.opening_type) {
      if (!isManager) throw Object.assign(new Error('نوع الرصيد مقفل بعد الإدخال'), { code: 403 });
      const nt = b.opening_type === 'سلفة على العامل' ? 'سلفة على العامل' : 'مستحق للعامل';
      if (nt !== r.opening_type) {
        const oldT = r.opening_type;
        r.opening_type = nt;
        audit(d, 'opening_fix', col.slice(0, -1), r.id, ctx.user, ctx.role + ' (' + oldT + '→' + nt + ')');
      }
    }
    if (col === 'workers' && b.job !== undefined) r.job = validJob(b.job);
    if (col === 'customers' || col === 'suppliers') {
      // البطاقة التجارية قابلة للتعديل دائماً (ليست رصيداً مقفلاً)
      // المورد: تُتجاهل الحقول المحذوفة (صنف/نوع سعر/بطاقة مربي) وتُطهَّر من البطاقات القديمة
      if (col === 'customers') {
        if (b.kind !== undefined) r.kind = validCustomerKind(b.kind);
        if (b.price_type !== undefined) r.price_type = validCustomerPrice(b.price_type);
        if (b.breeder_card !== undefined) r.breeder_card = fiscalNum(b.breeder_card, 'بطاقة المربي/الفلاح');
        if (b.debt_limit !== undefined) r.debt_limit = Math.max(0, toNum(b.debt_limit, 'سقف الدين'));
        if (b.idle_days !== undefined) r.idle_days = parseIdleDays(b.idle_days);
      } else {
        delete r.kind; delete r.price_type; delete r.breeder_card;
      }
      if (b.rc !== undefined) r.rc = fiscalNum(b.rc, 'R.C');
      if (b.mf !== undefined) r.mf = fiscalNum(b.mf, 'M.F');
      if (b.art_imp !== undefined) r.art_imp = fiscalNum(b.art_imp, 'Art IMP');
      if (b.nis !== undefined) r.nis = fiscalNum(b.nis, 'N.I.S');
      if (col === 'suppliers' && b.bank !== undefined) r.bank = fiscalNum(b.bank, 'البنك', 60);
    }
    if (b.name !== undefined) {
      if (!hasText(b.name)) throw Object.assign(new Error('الاسم مطلوب'), { code: 400 });
      const dupLabel = col === 'suppliers' ? 'المورد' : col === 'customers' ? 'الزبون' : 'العامل';
      if (d[col].some(x => x.id !== r.id && String(x.name || '').trim() === String(b.name).trim())) {
        throw Object.assign(new Error('هذا الاسم مستعمل («' + String(b.name).trim() + '») — أدخل اسماً مغايراً'), { code: 400 });
      }
      r.name = b.name.trim();
    }
    if (b.phone !== undefined) {
      const ph = checkPhone(b.phone);
      if (col === 'customers' && (!ph || ph.length < 9 || ph.length > 15)) throw Object.assign(new Error('هاتف الزبون إجباري: 9-15 رقماً'), { code: 400 });
      r.phone = ph;
    }
    if (b.address !== undefined) r.address = String(b.address || '').trim();
    if (b.active !== undefined) r.active = !!b.active;
    r.updated_at = now();
    audit(d, 'update', col.slice(0, -1), id, ctx.user, ctx.role);
    store.save(d);
    return { data: r };
  },
  updateSupplier: (id, b, ctx) => Master._updateParty('suppliers', id, b, ctx),
  updateCustomer: (id, b, ctx) => Master._updateParty('customers', id, b, ctx),
  updateWorker: (id, b, ctx) => Master._updateParty('workers', id, b, ctx),

  _deleteParty(col, id, ctx) {
    const d = store.load();
    const i = d[col].findIndex(x => x.id === id);
    if (i < 0) throw Object.assign(new Error('غير موجود'), { code: 404 });
    const r = d[col][i];
    const openField = col === 'workers' ? 'opening_balance' : 'opening_debt';
    const logEntity = col === 'suppliers' ? 'supplier' : col === 'customers' ? 'customer' : 'worker';
    if (toNum(r[openField] ?? 0, 'الرصيد') !== 0 || d.opening_log.some(o => o.entity === logEntity && o.ref_id === id)) {
      throw Object.assign(new Error('ممنوع الحذف: توجد أرصدة أو حركات مرتبطة — عطّل البطاقة بدل الحذف'), { code: 400 });
    }
    // روابط حية: الحذف هنا يُيتّم سجلات الأقسام — المنع مع السبب والحل
    const liveLinks = require('./jstore');
    if (col === 'suppliers') {
      const pd = liveLinks('procurement.json', { orders: [], deposits: [], confirmations: [] }).load();
      const no = (pd.orders || []).filter(x => Number(x.supplier_id) === Number(id)).length;
      const nc = (pd.confirmations || []).filter(x => Number(x.supplier_id) === Number(id)).length;
      const nd = (pd.deposits || []).filter(x => Number(x.supplier_id) === Number(id)).length;
      if (no + nc + nd > 0) {
        throw Object.assign(new Error('ممنوع الحذف: المورد مرتبط بـ ' + no + ' طلبية و' + nc + ' تأكيد و' + nd + ' دفعة — عطّل البطاقة بدل الحذف (تبقى السجلات سليمة)'), { code: 400 });
      }
    }
    if (col === 'customers') {
      const sd = liveLinks('sales.json', { invoices: [], receipts: [], cmdorders: [] }).load();
      const ni = (sd.invoices || []).filter(x => Number(x.customer_id) === Number(id)).length;
      const nc = (sd.cmdorders || []).filter(x => Number(x.customer_id) === Number(id)).length;
      if (ni + nc > 0) {
        throw Object.assign(new Error('ممنوع الحذف: الزبون مرتبط بـ ' + ni + ' فاتورة و' + nc + ' طلبية — عطّل البطاقة بدل الحذف (تبقى السجلات سليمة)'), { code: 400 });
      }
    }
    if (col === 'workers') {
      const ed = liveLinks('employees.json', { profiles: [], attendance: [], advances: [], adjustments: [], payrolls: [] }).load();
      const hits = ['profiles', 'attendance', 'advances', 'adjustments', 'payrolls']
        .map(k => ((ed[k] || []).some(x => Number(x.worker_id) === Number(id)) ? k : null)).filter(Boolean);
      if (hits.length) {
        throw Object.assign(new Error('ممنوع الحذف: العامل مرتبط بسجلات الموظفين — عطّل البطاقة بدل الحذف (تبقى السجلات سليمة)'), { code: 400 });
      }
    }
    d[col].splice(i, 1);
    audit(d, 'delete', col.slice(0, -1), id, ctx.user, ctx.role);
    store.save(d);
    return { ok: true };
  },
  deleteSupplier: (id, ctx) => Master._deleteParty('suppliers', id, ctx),
  deleteCustomer: (id, ctx) => Master._deleteParty('customers', id, ctx),
  deleteWorker: (id, ctx) => Master._deleteParty('workers', id, ctx),

  // ---- وظائف وأقسام ----
  addJob(b, ctx) {
    if (!Auth.can(ctx.role, 'master', 'party')) throw Object.assign(new Error('صلاحية الجهات والمخازن: مدير المخزون أو المدير العام فقط'), { code: 403 });
    if (!hasText(b.name)) throw Object.assign(new Error('اسم الوظيفة/القسم مطلوب'), { code: 400 });
    const d = store.load();
    const row = { id: d.seq.job++, name: b.name.trim(), description: (b.description || '').trim(), created_at: now(), updated_at: now() };
    d.jobs.push(row);
    audit(d, 'add', 'job', row.id, ctx.user, ctx.role);
    store.save(d);
    return { data: row };
  },
  updateJob(id, b, ctx) {
    if (!Auth.can(ctx.role, 'master', 'party')) throw Object.assign(new Error('صلاحية الجهات والمخازن: مدير المخزون أو المدير العام فقط'), { code: 403 });
    const d = store.load();
    const r = d.jobs.find(x => x.id === id);
    if (!r) throw Object.assign(new Error('غير موجود'), { code: 404 });
    if (b.name !== undefined) { if (!hasText(b.name)) throw Object.assign(new Error('الاسم مطلوب'), { code: 400 }); r.name = b.name.trim(); }
    if (b.description !== undefined) r.description = String(b.description || '').trim();
    r.updated_at = now();
    audit(d, 'update', 'job', id, ctx.user, ctx.role);
    store.save(d);
    return { data: r };
  },
  deleteJob(id, ctx) {
    if (!Auth.can(ctx.role, 'master', 'party')) throw Object.assign(new Error('صلاحية الجهات والمخازن: مدير المخزون أو المدير العام فقط'), { code: 403 });
    const d = store.load();
    const i = d.jobs.findIndex(x => x.id === id);
    if (i < 0) throw Object.assign(new Error('غير موجود'), { code: 404 });
    d.jobs.splice(i, 1);
    audit(d, 'delete', 'job', id, ctx.user, ctx.role);
    store.save(d);
    return { ok: true };
  },

  // ---- تصنيفات المصاريف: تُغذي قائمة المالية (تبويب المصاريف) مباشرة ----
  // البذر من القائمة القديمة الصلبة أول مرة — بعدها البطاقات هي المرجع الوحيد
  _seedExpcats(d) {
    if (!Array.isArray(d.expcats)) d.expcats = [];
    if (d.expcats.length) return false;
    for (const n of ['كهرباء', 'إيجار', 'صيانة', 'وقود', 'أجور مؤقتة', 'رواتب', 'سلف', 'أخرى']) {
      d.expcats.push({ id: d.seq.expcat++, name: n, active: true, created_at: now(), updated_at: now() });
    }
    return true;
  },
  _needExpCat(ctx) {
    if (!Auth.can(ctx.role, 'finance', 'expense')) throw Object.assign(new Error('تصنيفات المصاريف: المدير العام أو المحاسب فقط'), { code: 403 });
  },
  listExpcats() {
    const d = store.load();
    if (Master._seedExpcats(d)) store.save(d);
    return { data: d.expcats };
  },
  addExpCat(b, ctx) {
    Master._needExpCat(ctx);
    const name = String((b || {}).name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw Object.assign(new Error('اسم التصنيف مطلوب'), { code: 400 });
    const d = store.load();
    Master._seedExpcats(d);
    if (d.expcats.some(x => x.name.trim() === name)) throw Object.assign(new Error('التصنيف موجود مسبقاً'), { code: 400 });
    const row = { id: d.seq.expcat++, name, active: b.active === undefined ? true : !!b.active, created_at: now(), updated_at: now() };
    d.expcats.push(row);
    audit(d, 'add', 'expcat', row.id, ctx.user, ctx.role);
    store.save(d);
    return { data: row };
  },
  updateExpCat(id, b, ctx) {
    Master._needExpCat(ctx);
    const d = store.load();
    const r = d.expcats.find(x => x.id === Number(id));
    if (!r) throw Object.assign(new Error('غير موجود'), { code: 404 });
    if (b.name !== undefined) {
      const name = String(b.name || '').trim().replace(/\s+/g, ' ');
      if (!name) throw Object.assign(new Error('اسم التصنيف مطلوب'), { code: 400 });
      if (d.expcats.some(x => x.id !== r.id && x.name.trim() === name)) throw Object.assign(new Error('التصنيف موجود مسبقاً'), { code: 400 });
      r.name = name;
    }
    if (b.active !== undefined) r.active = !!b.active;
    r.updated_at = now();
    audit(d, 'update', 'expcat', r.id, ctx.user, ctx.role);
    store.save(d);
    return { data: r };
  },
  deleteExpCat(id, ctx) {
    Master._needExpCat(ctx);
    const d = store.load();
    const i = d.expcats.findIndex(x => x.id === Number(id));
    if (i < 0) throw Object.assign(new Error('غير موجود'), { code: 404 });
    let used = 0;
    try {
      const fd = require('./jstore')('finance.json', { expenses: [] }).load();
      used = (fd.expenses || []).filter(x => String(x.category || '') === String(d.expcats[i].name)).length;
    } catch {}
    if (used > 0) throw Object.assign(new Error('ممنوع الحذف: مستعمل في ' + used + ' مصروف — عطّله بدل الحذف'), { code: 400 });
    d.expcats.splice(i, 1);
    audit(d, 'delete', 'expcat', id, ctx.user, ctx.role);
    store.save(d);
    return { ok: true };
  },

  // ---- مخازن ----
  addWarehouse(b, ctx) {
    if (!hasText(b.name)) throw Object.assign(new Error('اسم المخزن مطلوب'), { code: 400 });
    if (b.type && !['مواد أولية', 'منتج نهائي'].includes(b.type)) throw Object.assign(new Error('نوع المخزن: مواد أولية / منتج نهائي'), { code: 400 });
    const d = store.load();
    if (d.warehouses.some(x => String(x.name || '').trim() === String(b.name).trim())) {
      throw Object.assign(new Error('هذا الاسم مستعمل («' + String(b.name).trim() + '») — أدخل اسماً مغايراً'), { code: 400 });
    }
    const row = { id: d.seq.warehouse++, code: nextCode(d, 'warehouses', d.warehouses, b.code), name: b.name.trim(), place: (b.place || '').trim(), type: b.type || 'مواد أولية', opening_stock: toNum(b.opening_stock, 'المخزون الافتتاحي'), fixed: false, created_at: now(), updated_at: now() };
    d.warehouses.push(row);
    audit(d, 'add', 'warehouse', row.id, ctx.user, ctx.role);
    store.save(d);
    return { data: row };
  },
  updateWarehouse(id, b, ctx) {
    const d = store.load();
    const r = d.warehouses.find(x => x.id === id);
    if (!r) throw Object.assign(new Error('غير موجود'), { code: 404 });
    if (b.name !== undefined) {
      if (!hasText(b.name)) throw Object.assign(new Error('الاسم مطلوب'), { code: 400 });
      if (d.warehouses.some(x => x.id !== r.id && String(x.name || '').trim() === String(b.name).trim())) {
        throw Object.assign(new Error('هذا الاسم مستعمل («' + String(b.name).trim() + '») — أدخل اسماً مغايراً'), { code: 400 });
      }
      r.name = b.name.trim();
    }
    if (b.place !== undefined) r.place = String(b.place || '').trim();
    if (b.type !== undefined) { if (!['مواد أولية', 'منتج نهائي'].includes(b.type)) throw Object.assign(new Error('نوع غير صالح'), { code: 400 }); r.type = b.type; }
    if (b.opening_stock !== undefined) r.opening_stock = toNum(b.opening_stock, 'المخزون الافتتاحي');
    r.updated_at = now();
    audit(d, 'update', 'warehouse', id, ctx.user, ctx.role);
    store.save(d);
    return { data: r };
  },
  deleteWarehouse(id, ctx) {
    const d = store.load();
    const i = d.warehouses.findIndex(x => x.id === id);
    if (i < 0) throw Object.assign(new Error('غير موجود'), { code: 404 });
    if (d.warehouses[i].fixed) throw Object.assign(new Error('ممنوع حذف المخزنين الثابتين: المواد الأولية والمنتج النهائي'), { code: 400 });
    // مخزن به رصيد: الحذف يبتر اللوتات — المنع مع الحل (تحويل الرصيد أولاً من المخزون)
    try {
      const invD = require('./jstore')('inventory.json', { lots: [] }).load();
      const left = (invD.lots || []).filter(l => Number(l.warehouse_id) === Number(id)).reduce((s, l) => s + Number(l.remaining || 0), 0);
      if (left > 0) throw Object.assign(new Error('ممنوع الحذف: المخزن به رصيد ' + left + ' — حوّله لمخزن آخر من تبويب المخزون ثم احذف'), { code: 400 });
    } catch (e) { if (e && e.code === 400) throw e; }
    d.warehouses.splice(i, 1);
    audit(d, 'delete', 'warehouse', id, ctx.user, ctx.role);
    store.save(d);
    return { ok: true };
  },

  // ---- التركيبات: رقم ثابت TRK + تاريخ سريان + نسخ جديدة دائماً (لا تعديل مباشر) ----
  _nextFormulaNum(d) {
    return System.formatNum('formula', { n: d.seq.formula_num++ });
  },
  _validEffDate(v) {
    const s = String(v || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
      throw Object.assign(new Error('تاريخ السريان مطلوب بصيغة صحيحة (سنة-شهر-يوم)'), { code: 400 });
    }
    return s;
  },
  _cleanFormulaItems(d, items) {
    if (!Array.isArray(items)) throw Object.assign(new Error('مكونات التركيبة مطلوبة'), { code: 400 });
    const out = [];
    for (const it of items) {
      const item = d.items.find(x => x.id === Number(it.item_id));
      if (!item) throw Object.assign(new Error('مادة غير موجودة في البيانات الأساسية'), { code: 400 });
      // التركيبة وصفة علفية من الخام فقط — لا منتج نهائي ولا تغليف (التغليف على أمر الإنتاج)
      const cmain = ((d.categories || []).find(c => c.id === Number(item.category_id)) || {}).main;
      if (cmain !== 'مواد أولية') throw Object.assign(new Error('التركيبة للمواد الأولية فقط (' + item.name + ' مصنفة «' + (cmain || 'بلا تصنيف') + '»)'), { code: 400 });
      const qty = toNum(it.qty, 'كمية ' + item.name);
      if (qty < 0) throw Object.assign(new Error('الكمية لا تكون سالبة'), { code: 400 });
      if (qty > 0 && !out.some(o => o.item_id === item.id)) {
        out.push({ item_id: item.id, item_name: item.name, qty, unit: item.unit });
      }
    }
    if (!out.length) throw Object.assign(new Error('اختر مادة واحدة على الأقل بكمية أكبر من صفر'), { code: 400 });
    return out;
  },
  _formulaUsed(d, id) {
    return (d.production_orders || []).some(o => o.formula_id === id);
  },
  // بطاقة منتج مطابقة للتركيبة: مربوطة صالحة ← تُستخدم، اسم تام مطابق ← يُربط، وإلا تُنشأ
  _ensureProduct(d, frow, ctx) {
    if (frow.product_id) {
      const ex = d.items.find(x => x.id === frow.product_id);
      if (ex) return ex;
    }
    const nm = String(frow.name || '').trim();
    const same = d.items.find(x => x.name.trim() === nm && (() => {
      const c = d.categories.find(cc => cc.id === x.category_id);
      return c && c.main === 'منتج نهائي';
    })());
    if (same) {
      if (!Number.isFinite(Number(same.shelf_months)) || Number(same.shelf_months) <= 0) {
        same.shelf_months = DEFAULT_PRD_SHELF_MONTHS; same.updated_at = now();
      }
      frow.product_id = same.id; return same;
    }
    const cat = resolveCategory(d, 'منتج نهائي', 'منتجات التركيبات', ctx);
    const row = {
      id: d.seq.item++, code: nextCode(d, 'items_prd', d.items), name: nm,
      category_id: cat.id, unit: 'قنطار',
      min_stock: 0, last_price: 0,
      shelf_months: DEFAULT_PRD_SHELF_MONTHS,
      status: 'نشطة', price_updated_at: now(),
      created_at: now(), updated_at: now()
    };
    d.items.push(row);
    audit(d, 'add', 'item', row.id, (ctx && ctx.user) || 'system', (ctx && ctx.role) || 'admin');
    frow.product_id = row.id;
    return row;
  },
  makeProduct(id, ctx) {
    if (!Auth.can(ctx.role, 'master', 'item')) throw Object.assign(new Error('صلاحية البطاقات: مدير المخزون أو المدير العام فقط'), { code: 403 });
    const d = store.load();
    const f = d.formulas_ref.find(x => x.id === Number(id));
    if (!f) throw Object.assign(new Error('التركيبة غير موجودة'), { code: 404 });
    const product = this._ensureProduct(d, f, ctx);
    audit(d, 'link-product', f.id, ctx.user, ctx.role);
    store.save(d);
    return { data: { formula: f.num, product } };
  },
  addFormula(b, ctx) {
    if (!hasText(b.name)) throw Object.assign(new Error('اسم التركيبة مطلوب'), { code: 400 });
    const d = store.load();
    // التركيبة الجديدة باسم مستعمل مرفوضة — النسخ من نفس الاسم تُنشأ بزر «نسخة جديدة» فقط
    if (d.formulas_ref.some(x => String(x.name || '').trim() === String(b.name).trim())) {
      throw Object.assign(new Error('هذا الاسم مستعمل («' + String(b.name).trim() + '») — أدخل اسماً مغايراً أو أنشئ نسخة جديدة من التركيبة الموجودة'), { code: 400 });
    }
    const date = this._validEffDate(b.date);
    const comps = this._cleanFormulaItems(d, b.items);
    const row = {
      id: d.seq.formula++, num: this._nextFormulaNum(d), name: b.name.trim(), date,
      status: b.status === 'متوقفة' ? 'متوقفة' : 'نشطة',
      note: String(b.note || '').trim(), parent_num: null,
      created_at: now(), updated_at: now()
    };
    d.formulas_ref.push(row);
    for (const c of comps) d.formula_items.push({ id: d.seq.formula_item++, formula_id: row.id, ...c });
    let product = null;
    if (b.auto_product) product = this._ensureProduct(d, row, ctx);
    audit(d, 'add', 'formula_ref', row.id, ctx.user, ctx.role);
    store.save(d);
    return { data: { ...row, items: comps, product } };
  },
  newFormulaVersion(id, b, ctx) {
    const d = store.load();
    const src = d.formulas_ref.find(x => x.id === id);
    if (!src) throw Object.assign(new Error('التركيبة الأصلية غير موجودة'), { code: 404 });
    const date = this._validEffDate(b.date !== undefined ? b.date : new Date().toISOString().slice(0, 10));
    const srcItems = d.formula_items.filter(x => x.formula_id === id).map(x => ({ item_id: x.item_id, qty: x.qty }));
    const comps = this._cleanFormulaItems(d, b.items !== undefined ? b.items : srcItems);
    const row = {
      id: d.seq.formula++, num: this._nextFormulaNum(d),
      name: hasText(b.name) ? b.name.trim() : src.name, date,
      status: b.status === 'متوقفة' ? 'متوقفة' : 'نشطة',
      note: String(b.note !== undefined ? b.note : ('نسخة من ' + src.num)).trim(),
      parent_num: src.num, created_at: now(), updated_at: now()
    };
    d.formulas_ref.push(row);
    for (const c of comps) d.formula_items.push({ id: d.seq.formula_item++, formula_id: row.id, ...c });
    let product = null;
    if (src.product_id) {
      const ex = d.items.find(x => x.id === src.product_id);
      if (ex) { row.product_id = ex.id; product = ex; }
    }
    if (!product && b.auto_product) product = this._ensureProduct(d, row, ctx);
    audit(d, 'version', 'formula_ref', row.id, ctx.user, ctx.role);
    store.save(d);
    return { data: { ...row, items: comps, product } };
  },
  getFormula(id) {
    const d = store.load();
    const r = d.formulas_ref.find(x => x.id === id);
    if (!r) throw Object.assign(new Error('غير موجود'), { code: 404 });
    return { data: { ...r, items: d.formula_items.filter(x => x.formula_id === id) } };
  },
  listFormulas() {
    const d = store.load();
    const data = d.formulas_ref.map(f => {
      const items = d.formula_items.filter(x => x.formula_id === f.id);
      return { ...f, items_count: items.length, total_qty: Math.round(items.reduce((s, x) => s + Number(x.qty || 0), 0) * 100) / 100 };
    }).sort((a, b) => (a.num < b.num ? 1 : -1));
    return { data };
  },
  updateFormula() {
    throw Object.assign(new Error('التعديل المباشر ممنوع — أنشئ نسخة جديدة برقم ثابت جديد'), { code: 400 });
  },
  deleteFormula(id, ctx) {
    const d = store.load();
    const i = d.formulas_ref.findIndex(x => x.id === id);
    if (i < 0) throw Object.assign(new Error('غير موجود'), { code: 404 });
    if (this._formulaUsed(d, id)) throw Object.assign(new Error('ممنوع الحذف: التركيبة مستعملة في إنتاج — أوقفها بدل الحذف'), { code: 400 });
    d.formula_items = d.formula_items.filter(x => x.formula_id !== id);
    d.formulas_ref.splice(i, 1);
    audit(d, 'delete', 'formula_ref', id, ctx.user, ctx.role);
    store.save(d);
    return { ok: true };
  }
};

module.exports = Master;

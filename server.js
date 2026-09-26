// دار العلف V2 — خادم نظيف: تقديم الواجهة + API البيانات الأساسية (9 تبويبات)
// صفر اعتماديات: node:http فقط
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Master = require('./src/master');
const store = require('./src/store');
const Proc = require('./src/procurement');
const Quality = require('./src/quality');
const Inv = require('./src/inventory');
const Trace = require('./src/trace');
const Formulas = require('./src/formulas');
const Prod = require('./src/production');
const Sales = require('./src/sales');
const Finance = require('./src/finance');
const Emp = require('./src/employees');
const System = require('./src/system');
const Rep = require('./src/reports');
const Dash = require('./src/dashboard');
const Analytics = require('./src/analytics');
const Notif = require('./src/notifications');
const Auth = require('./src/auth');
const Reset = require('./src/reset');
const Billing = require('./src/billing');

const PORT = process.env.PORT || 3001;
const FRONT = path.join(__dirname, '..', 'frontend');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

// وضع الدخول المفتوح المؤقت (OPEN_MODE=1): كل الطلبات بصلاحيات المدير العام
// والواجهة تتجاوز شاشة الدخول — للتجربة المحلية فقط، عطّله للإنتاج
const OPEN_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.OPEN_MODE || '').toLowerCase());
const getCtx = req => OPEN_MODE ? { user: 'admin', role: 'admin', uid: 1 } : Auth.ctxFromReq(req);

// قفل كتابة عام: يسلّسل كل طفرات /api (غير GET) فيسلّسل مقاطع load→save بين الطلبات.
// كل منطق الوحدات متزامن اليوم (لا await داخل src) فالنافذة نظرية، والقفل ضمان للمستقبل + توثيق للثابت.
let __writeTail = Promise.resolve();
async function lockWrite() {
  let unlock;
  const cur = new Promise(r => { unlock = r; });
  const prev = __writeTail;
  __writeTail = cur;
  await prev;
  return unlock;
}

// P0-Netlify: المنشأ المسموح عبر بيئة + localhost — أي Origin آخر لا يحصل على ترويسة CORS ويُرفض على طلبات التعديل
// اضبط على سيرفر الإنتاج: ALLOWED_ORIGINS=https://your-site.netlify.app,https://your-backend.onrender.com
// أو FRONTEND_URL=https://your-site.netlify.app (يُضاف تلقائياً)
function buildAllowedOrigins() {
  const s = new Set(['http://localhost:3001', 'http://127.0.0.1:3001']);
  // السماح لنفس المنفذ الحالي ديناميكياً (مهم عند تغيير PORT)
  try {
    s.add('http://localhost:' + PORT);
    s.add('http://127.0.0.1:' + PORT);
  } catch {}
  const fromEnv = String(process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);
  for (const o of fromEnv) s.add(o);
  for (const k of ['FRONTEND_URL', 'NETLIFY_URL', 'URL']) {
    const v = String(process.env[k] || '').trim().replace(/\/$/, '');
    if (v) s.add(v);
  }
  return s;
}
const ALLOWED_ORIGINS = buildAllowedOrigins();
function send(res, code, obj) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' };
  if (res.__origin) h['Access-Control-Allow-Origin'] = res.__origin;
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 8388608); // حد 8MB: اللقطات الكاملة تحمل صور base64 — الاستعادة للمدير فقط
function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    let tooBig = false;
    req.on('data', c => {
      if (tooBig) return;
      d += c;
      if (d.length > MAX_BODY) {
        tooBig = true;
        try { req.destroy(); } catch {}
        reject(Object.assign(new Error('حجم الطلب يتجاوز الحد المسموح (8MB)'), { code: 413 }));
      }
    });
    req.on('end', () => { if (!tooBig) { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } } });
    req.on('error', () => { if (!tooBig) resolve({}); });
  });
}
function serveStatic(req, res, p) {
  if (req.method !== 'GET' || p.startsWith('/api/')) return false;
  let rel = decodeURIComponent(p);
  if (rel.endsWith('/')) rel += 'index.html';
  const fp = path.normalize(path.join(FRONT, rel));
  if (!fp.startsWith(FRONT)) { res.writeHead(403); res.end(); return true; }
  let file = fp;
  try {
    const st = fs.statSync(fp);
    if (st.isDirectory()) file = path.join(fp, 'index.html');
  } catch { return false; }
  try {
    // P3: كاش ذكي — الأصول ثابتة طويلاً، الـ SW والـ HTML دائماً طازجة
    const ext = path.extname(file);
    const relUrl = String(p || '');
    let cc = 'no-cache';
    if (relUrl.startsWith('/assets/')) cc = 'public, max-age=31536000, immutable';
    if (file.endsWith('sw.js')) cc = 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cc });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch { return false; }
}
const numId = (p, base) => Number(String(p).slice(String(base).length).split('/')[0]);

// فحص طلبات التعديل: Origin مرفوض من الخارج + Content-Type يجب أن يكون JSON
// تُستثنى الواجهة العمومية (/api/public/) من فحص Origin (زوار بلا حساب) — تبقى الحماية بالمعدل والتحقق
function guardMutation(req, p) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  if (p && p.startsWith('/api/public/')) {
    const ct0 = String((req.headers && req.headers['content-type']) || '').split(';')[0].trim().toLowerCase();
    if (ct0 !== 'application/json') throw Object.assign(new Error('Content-Type يجب أن يكون application/json'), { code: 415 });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const o = String((req.headers && req.headers.origin) || '');
  if (o && !ALLOWED_ORIGINS.has(o)) {
    const e = new Error('الأصل (Origin) مرفوض — أضف دومين الواجهة إلى ALLOWED_ORIGINS في البيئة');
    throw Object.assign(e, { code: 403 });
  }
  const ct = String((req.headers && req.headers['content-type']) || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') throw Object.assign(new Error('Content-Type يجب أن يكون application/json'), { code: 415 });
}

// ---- فحص الصلاحيات الموحد: كل نقطة API → (قسم، إجراء) عبر Auth.can ----
// القاعدة: الفحص عند البوابة (server.js) ثم الفحص داخل الوحدات — دفاع مزدوج بنفس المصدر
function needPerm(ctx, sec, act) {
  if (!ctx || ctx.role === 'guest') throw Object.assign(new Error('سجل الدخول أولاً'), { code: 401 });
  if (!sec) return;
  if (!Auth.can(ctx.role, sec, act)) throw Object.assign(new Error('غير مصرح لك بهذا الإجراء'), { code: 403 });
}
const W = (re, sec, act) => ({ re, sec, act });
const NO_PERM = ['/api/health', '/api/login', '/api/logout', '/api/system/public', '/api/public/catalog', '/api/public/landing', '/api/public/orders', '/api/public/orders/track'];
const AUTH_ONLY = ['/api/auth/password', '/api/auth/permissions', '/api/dashboard', '/api/notifications'];
const READ_PERM = [
  ['/api/master/', 'master', 'view'],
  ['/api/procurement/', 'procurement', 'view'],
  ['/api/quality/', 'quality', 'view'],
  ['/api/inventory/', 'inventory', 'view'],
  ['/api/trace/', 'trace', 'view'],
  ['/api/formulas/', 'formulas', 'view'],
  ['/api/production/', 'production', 'view'],
  ['/api/sales/', 'sales', 'view'],
  ['/api/billing/', 'sales', 'view'],
  ['/api/finance/', 'finance', 'view'],
  ['/api/employees/', 'employees', 'view'],
  ['/api/reports/', 'reports', 'view'],
  ['/api/analytics/', 'reports', 'view'],
  ['/api/users', 'users', 'view'],
  ['/api/roles', 'users', 'view'],
  ['/api/system/', 'system', 'view'],
  ['/api/auth/events', 'users', 'view'],
  ['/api/auth/kpi', 'users', 'view']
];
const WRITE_PERM = [
  // (الترتيب مهم: الأنماط الأكثر تحديداً أولاً)
  W(/^\/api\/system\/design-(backups|restore)$/, 'system', 'backup'),
  W(/^\/api\/system\/(data-backup|data-restore|archives|backup-catalog|snapshots|snapshot-(restore|delete|file)|reset-(sales|procurement))$/, 'system', 'backup'),
  W(/^\/api\/system\/(config|changelog)/, 'system', 'config'),
  W(/^\/api\/users(\/|$)/, 'users', 'manage'),
  W(/^\/api\/roles(\/|$)/, 'users', 'manage'),
  W(/^\/api\/master\/expcats(\/|$)/, 'finance', 'expense'),
  W(/^\/api\/master\/categories(\/|$)/, 'master', 'item'),
  W(/^\/api\/master\/items(\/|$)/, 'master', 'item'),
  W(/^\/api\/master\/formulas-ref(\/|$)/, 'master', 'item'),
  W(/^\/api\/master\/(suppliers|customers|workers|jobs|warehouses)(\/|$)/, 'master', 'party'),
  W(/^\/api\/master\/codes(\/|$)/, 'master', 'party'),
  W(/^\/api\/procurement\/orders\/\d+\/decide/, 'procurement', 'approve'),
  W(/^\/api\/procurement\/confirmations(\/|$)/, 'procurement', 'confirm'),
  W(/^\/api\/procurement\/payments(\/|$)/, 'procurement', 'deposit'),
  W(/^\/api\/procurement\/orders(\/|$)/, 'procurement', 'order'),
  W(/^\/api\/procurement\/deposits(\/|$)/, 'procurement', 'deposit'),
  W(/^\/api\/quality\/decide/, 'quality', 'decide'),
  W(/^\/api\/inventory\/counts\/\d+\/approve/, 'inventory', 'approve'),
  W(/^\/api\/inventory\/(transfer|counts|wastes)(\/|$)/, 'inventory', 'move'),
  W(/^\/api\/production\/orders\/\d+\/(start|cancel|close)/, 'production', 'execute'),
  W(/^\/api\/production\/orders(\/|$)/, 'production', 'order'),
  W(/^\/api\/sales\/invoices\/\d+\/confirm/, 'sales', 'invoice'),
  W(/^\/api\/sales\/invoices(\/|$)/, 'sales', 'invoice'),
  W(/^\/api\/sales\/receipts(\/|$)/, 'sales', 'receipt'),
  W(/^\/api\/sales\/standalone-receipts(\/|$)/, 'sales', 'receipt'),
  W(/^\/api\/sales\/returns(\/|$)/, 'sales', 'return'),
   W(/^\/api\/sales\/cmd-orders(\/|$)/, 'sales', 'invoice'),
   W(/^\/api\/sales\/ext-orders(\/|$)/, 'sales', 'invoice'),
  W(/^\/api\/billing\/receipts\/\d+\/receive/, 'sales', 'receipt'),
  W(/^\/api\/billing\/receipts\/\d+\/archive/, 'sales', 'receipt'),
  W(/^\/api\/billing\/invoices(\/|$)/, 'sales', 'invoice'),
  W(/^\/api\/finance\/accounts(\/|$)/, 'finance', 'account'),
  W(/^\/api\/finance\/transfers(\/|$)/, 'finance', 'account'),
  W(/^\/api\/finance\/expenses(\/|$)/, 'finance', 'expense'),
  W(/^\/api\/finance\/incomes(\/|$)/, 'finance', 'income'),
  W(/^\/api\/employees\/profiles(\/|$)/, 'employees', 'pay'),
  W(/^\/api\/employees\/attendance(\/|$)/, 'employees', 'attend'),
  W(/^\/api\/employees\/(advances|adjustments|payrolls)(\/|$)/, 'employees', 'pay')
];
function checkRoutePerm(p, method, ctx) {
  if (!p.startsWith('/api/')) return;
  if (NO_PERM.indexOf(p) >= 0) return;
  if (AUTH_ONLY.some(x => p.startsWith(x))) return needPerm(ctx);
  if (method !== 'GET') {
    for (const e of WRITE_PERM) if (e.re.test(p)) return needPerm(ctx, e.sec, e.act);
  }
  for (const [pre, sec, act] of READ_PERM) {
    if (p.startsWith(pre)) return needPerm(ctx, sec, act);
  }
}

// لقطات التصميم: نسخ آمنة لملفات الواجهة والمنطق مع استرجاع بضغطة
const DESIGN_FILES = [
  ['master-data.html', 'frontend/master-data/index.html'],
  ['layout.js', 'frontend/shared/utils/layout.js'],
  ['theme.css', 'frontend/assets/styles/theme.css'],
  ['master.js', 'backend/src/master.js'],
  ['procurement-page.html', 'frontend/procurement/index.html'],
  ['procurement.js', 'backend/src/procurement.js'],
  ['inventory-page.html', 'frontend/inventory/index.html'],
  ['inventory.js', 'backend/src/inventory.js'],
  ['trace-page.html', 'frontend/lots/index.html'],
  ['trace.js', 'backend/src/trace.js'],
  ['formulas-page.html', 'frontend/formulas/index.html'],
  ['formulas.js', 'backend/src/formulas.js'],
  ['production-page.html', 'frontend/production/index.html'],
  ['production.js', 'backend/src/production.js'],
  ['sales-page.html', 'frontend/sales/index.html'],
  ['sales.js', 'backend/src/sales.js'],
  ['employees-page.html', 'frontend/employees/index.html'],
  ['employees.js', 'backend/src/employees.js'],
  ['reports-page.html', 'frontend/reports/index.html'],
  ['reports.js', 'backend/src/reports.js']
];
const SNAP_DIR = path.join(__dirname, 'design-backups');
const DesignSnaps = {
  dir() { fs.mkdirSync(SNAP_DIR, { recursive: true }); return SNAP_DIR; },
  validId(id) { return /^[\w-]{1,64}$/.test(id || ''); },
  list() {
    this.dir();
    return fs.readdirSync(SNAP_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && this.validId(e.name))
      .map(e => {
        try { return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, e.name, 'manifest.json'), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  },
  save(label) {
    this.dir();
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 7);
    const dest = path.join(SNAP_DIR, id);
    if (!dest.startsWith(SNAP_DIR)) throw Object.assign(new Error('مسار مرفوض'), { code: 400 });
    fs.mkdirSync(dest, { recursive: true });
    for (const [name, rel] of DESIGN_FILES) {
      fs.copyFileSync(path.join(__dirname, '..', rel), path.join(dest, name));
    }
    const meta = { id, at: new Date().toISOString(), label, files: DESIGN_FILES.map(f => f[0]) };
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  },
  restore(id) {
    if (!this.validId(id)) throw Object.assign(new Error('نسخة غير صالحة'), { code: 404 });
    const src = path.join(this.dir(), id);
    if (!src.startsWith(SNAP_DIR) || !fs.existsSync(path.join(src, 'manifest.json'))) {
      throw Object.assign(new Error('النسخة غير موجودة'), { code: 404 });
    }
    const safety = this.save('حماية تلقائية قبل استرجاع ' + id);
    for (const [name, rel] of DESIGN_FILES) {
      fs.copyFileSync(path.join(src, name), path.join(__dirname, '..', rel));
    }
    return { restored: id, safety: safety.id };
  }
};

// حد معدل الدخول: 20 محاولة/دقيقة لكل IP (ذاكرة العملية فقط — تُصفى تلقائياً)
const LOGIN_RATE = { windowMs: 60000, max: 20, hits: new Map() };
function loginRateAllow(ip) {
  const nowMs = Date.now();
  let arr = LOGIN_RATE.hits.get(ip) || [];
  arr = arr.filter(t => nowMs - t < LOGIN_RATE.windowMs);
  if (arr.length >= LOGIN_RATE.max) { LOGIN_RATE.hits.set(ip, arr); return false; }
  arr.push(nowMs);
  LOGIN_RATE.hits.set(ip, arr);
  if (LOGIN_RATE.hits.size > 2000) LOGIN_RATE.hits.delete(LOGIN_RATE.hits.keys().next().value);
  return true;
}
// حد الطلبات الخارجية: 10 طلبات/ساعة لكل IP (ذاكرة العملية فقط)
const EXT_RATE = { windowMs: 3600000, max: 10, hits: new Map() };
function extRateAllow(ip) {
  const nowMs = Date.now();
  let arr = EXT_RATE.hits.get(ip) || [];
  arr = arr.filter(t => nowMs - t < EXT_RATE.windowMs);
  if (arr.length >= EXT_RATE.max) { EXT_RATE.hits.set(ip, arr); return false; }
  arr.push(nowMs);
  EXT_RATE.hits.set(ip, arr);
  if (EXT_RATE.hits.size > 2000) EXT_RATE.hits.delete(EXT_RATE.hits.keys().next().value);
  return true;
}

const server = http.createServer(async (req, res) => {
  res.__origin = String((req.headers && req.headers.origin) || '');
  res.__origin = ALLOWED_ORIGINS.has(res.__origin) ? res.__origin : '';
  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  // المدخل الرسمي: الترحيب أولاً (محلياً وإنتاجاً)
  if ((p === '/' || p === '') && req.method === 'GET') {
    res.writeHead(302, { Location: '/welcome/' });
    res.end();
    return;
  }
  if (serveStatic(req, res, p)) return;

  const ctx0 = getCtx(req);

  // أي طفرة API تُنفذ تحت القفل وتُحرر في finally (يعمل مع كل return داخل try)
  let __unlock = null;
  try {
    if (req.method !== 'GET' && p.startsWith('/api/')) __unlock = await lockWrite();
    guardMutation(req, p);
    checkRoutePerm(p, req.method, ctx0);
    if (p === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, project: 'dar-alef-v2', version: '2.2-p4', uptime: Math.round(process.uptime()), time: new Date().toISOString() });

    if (p === '/api/login' && req.method === 'POST') {
      // حد المعدل: 20 محاولة/دقيقة لكل IP (ذاكرة فقط — يمنع الإغراق قبل لمس القرص)
      const lip = String((req.socket && req.socket.remoteAddress) || 'unknown');
      if (!loginRateAllow(lip)) return send(res, 429, { error: 'محاولات كثيرة — انتظر دقيقة ثم أعد المحاولة' });
      const b = await body(req);
      const ip = (req.socket && req.socket.remoteAddress) || '';
      const ua = (req.headers && req.headers['user-agent']) || '';
      try {
        return send(res, 200, Auth.login(b.username, b.password, ip, ua, { force: b.force }));
      } catch (e) {
        const out = { error: (e && e.message) || 'خطأ داخلي' };
        if (e && e.details && typeof e.details === 'object') Object.assign(out, e.details);
        return send(res, (e && e.code) || 500, out);
      }
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const h = req.headers.authorization || '';
      Auth.logout(h.startsWith('Bearer ') ? h.slice(7) : '');
      return send(res, 200, { ok: true });
    }

    // ---- المصادقة: صلاحياتي + المستخدمون + الأدوار + التدقيق ----
    if (p === '/api/auth/permissions' && req.method === 'GET') {
      return send(res, 200, { data: Auth.myPerms(ctx0.role) });
    }
    if (p === '/api/auth/password' && req.method === 'PUT') {
      try {
        const c2 = getCtx(req);
        return send(res, 200, Auth.changePassword(await body(req), c2));
      } catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/users' && req.method === 'GET') return send(res, 200, Auth.listUsers(getCtx(req)));
    if (p === '/api/users' && req.method === 'POST') {
      try { return send(res, 200, Auth.addUser(await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p.startsWith('/api/users/') && p.endsWith('/reset') && req.method === 'POST') return send(res, 200, Auth.resetPassword(numId(p, '/api/users/'), await body(req), getCtx(req)));
    if (p.startsWith('/api/users/') && req.method === 'PUT') return send(res, 200, Auth.updateUser(numId(p, '/api/users/'), await body(req), getCtx(req)));
    if (p.startsWith('/api/users/') && req.method === 'DELETE') return send(res, 200, Auth.deleteUser(numId(p, '/api/users/'), getCtx(req)));
    if (p === '/api/roles' && req.method === 'GET') return send(res, 200, Auth.listRoles(getCtx(req)));
    if (p === '/api/roles' && req.method === 'POST') {
      try { return send(res, 200, Auth.addRole(await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p.startsWith('/api/roles/') && req.method === 'PUT') return send(res, 200, Auth.updateRole(p.slice('/api/roles/'.length).split('/')[0], await body(req), getCtx(req)));
    if (p.startsWith('/api/roles/') && req.method === 'DELETE') return send(res, 200, Auth.deleteRole(p.slice('/api/roles/'.length).split('/')[0], getCtx(req)));
    if (p === '/api/auth/events' && req.method === 'GET') return send(res, 200, Auth.auditView(getCtx(req), 200));
    if (p === '/api/auth/kpi' && req.method === 'GET') return send(res, 200, Auth.kpi(getCtx(req)));

    if (p === '/api/dashboard' && req.method === 'GET') return send(res, 200, { ok: true, moved: '/api/dashboard/full' });
    if (p === '/api/dashboard/full' && req.method === 'GET') return send(res, 200, Dash.full(getCtx(req)));
    // التحليلات: قراءة فقط — فحص أدق داخل الوحدة (reports للدخول + قسم كل رسم)
    if (p === '/api/analytics/meta' && req.method === 'GET') return send(res, 200, Analytics.meta(getCtx(req)));
    if (p === '/api/analytics/production' && req.method === 'GET') return send(res, 200, Analytics.production(url.searchParams, getCtx(req)));
    if (p === '/api/analytics/sales' && req.method === 'GET') return send(res, 200, Analytics.sales(url.searchParams, getCtx(req)));
    if (p === '/api/analytics/inventory' && req.method === 'GET') return send(res, 200, Analytics.inventory(url.searchParams, getCtx(req)));
    if (p === '/api/analytics/profit' && req.method === 'GET') return send(res, 200, Analytics.profit(url.searchParams, getCtx(req)));
    if (p === '/api/analytics/cost' && req.method === 'GET') return send(res, 200, Analytics.cost(url.searchParams, getCtx(req)));
    if (p === '/api/analytics/prices' && req.method === 'GET') return send(res, 200, Analytics.prices(url.searchParams, getCtx(req)));
    if (p === '/api/analytics/compare' && req.method === 'GET') return send(res, 200, Analytics.compare(url.searchParams, getCtx(req)));
    if (p === '/api/analytics/health' && req.method === 'GET') return send(res, 200, Analytics.health(url.searchParams, getCtx(req)));
    if (p === '/api/notifications' && req.method === 'GET') return send(res, 200, Notif.list(getCtx(req)));

    // ---- البيانات الأساسية ----
    if (p === '/api/master/kpi' && req.method === 'GET') return send(res, 200, Master.kpi());
    if (p === '/api/master/meta' && req.method === 'GET') {
      return send(res, 200, { data: { units: Master.UNITS, main_cats: Master.MAIN_CATS } });
    }
    if (p === '/api/master/order' && req.method === 'GET') return send(res, 200, { data: Master.kpi().data.order });
    if (p === '/api/master/codes' && req.method === 'GET') return send(res, 200, Master.codes());
    if (p === '/api/master/codes/mint' && req.method === 'POST') {
      try { return send(res, 200, Master.mintCustom(await body(req), ctx0)); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }

    const ctx = getCtx(req);

    // تصنيفات
    if (p === '/api/master/categories' && req.method === 'GET') return send(res, 200, Master.list('categories'));
    if (p === '/api/master/categories' && req.method === 'POST') return send(res, 200, Master.addCategory(await body(req), ctx));
    if (p.startsWith('/api/master/categories/') && req.method === 'PUT') return send(res, 200, Master.updateCategory(numId(p, '/api/master/categories/'), await body(req), ctx));
    if (p.startsWith('/api/master/categories/') && req.method === 'DELETE') return send(res, 200, Master.deleteCategory(numId(p, '/api/master/categories/'), ctx));

    // مواد
    if (p === '/api/master/items' && req.method === 'GET') return send(res, 200, Master.list('items'));
    if (p === '/api/master/items' && req.method === 'POST') return send(res, 200, Master.addItem(await body(req), ctx));
    if (p.startsWith('/api/master/items/') && req.method === 'PUT') return send(res, 200, Master.updateItem(numId(p, '/api/master/items/'), await body(req), ctx));
    if (p.startsWith('/api/master/items/') && req.method === 'DELETE') return send(res, 200, Master.deleteItem(numId(p, '/api/master/items/'), ctx));

    // موردون
    if (p === '/api/master/suppliers' && req.method === 'GET') return send(res, 200, Master.list('suppliers'));
    if (p === '/api/master/suppliers' && req.method === 'POST') return send(res, 200, Master.addSupplier(await body(req), ctx));
    if (p.startsWith('/api/master/suppliers/') && req.method === 'PUT') return send(res, 200, Master.updateSupplier(numId(p, '/api/master/suppliers/'), await body(req), ctx));
    if (p.startsWith('/api/master/suppliers/') && req.method === 'DELETE') return send(res, 200, Master.deleteSupplier(numId(p, '/api/master/suppliers/'), ctx));

    // زبائن
    if (p === '/api/master/customers' && req.method === 'GET') return send(res, 200, Master.list('customers'));
    if (p === '/api/master/customers' && req.method === 'POST') return send(res, 200, Master.addCustomer(await body(req), ctx));
    if (p.startsWith('/api/master/customers/') && req.method === 'PUT') return send(res, 200, Master.updateCustomer(numId(p, '/api/master/customers/'), await body(req), ctx));
    if (p.startsWith('/api/master/customers/') && req.method === 'DELETE') return send(res, 200, Master.deleteCustomer(numId(p, '/api/master/customers/'), ctx));

    // عمال
    if (p === '/api/master/workers' && req.method === 'GET') return send(res, 200, Master.list('workers'));
    if (p === '/api/master/workers' && req.method === 'POST') return send(res, 200, Master.addWorker(await body(req), ctx));
    if (p.startsWith('/api/master/workers/') && req.method === 'PUT') return send(res, 200, Master.updateWorker(numId(p, '/api/master/workers/'), await body(req), ctx));
    if (p.startsWith('/api/master/workers/') && req.method === 'DELETE') return send(res, 200, Master.deleteWorker(numId(p, '/api/master/workers/'), ctx));

    // وظائف
    if (p === '/api/master/jobs' && req.method === 'GET') return send(res, 200, Master.list('jobs'));
    if (p === '/api/master/jobs' && req.method === 'POST') return send(res, 200, Master.addJob(await body(req), ctx));
    if (p.startsWith('/api/master/jobs/') && req.method === 'PUT') return send(res, 200, Master.updateJob(numId(p, '/api/master/jobs/'), await body(req), ctx));
    if (p.startsWith('/api/master/jobs/') && req.method === 'DELETE') return send(res, 200, 
Master.deleteJob(numId(p, '/api/master/jobs/'), ctx));

    // تصنيفات المصاريف: قائمة المالية الديناميكية (القراءة للجميع — الإدارة للمدير/المحاسب داخل الدوال)
    if (p === '/api/master/expcats' && req.method === 'GET') return send(res, 200, Master.listExpcats());
    if (p === '/api/master/expcats' && req.method === 'POST') return send(res, 200, Master.addExpCat(await body(req), ctx));
    if (p.startsWith('/api/master/expcats/') && req.method === 'PUT') return send(res, 200, Master.updateExpCat(numId(p, '/api/master/expcats/'), await body(req), ctx));
    if (p.startsWith('/api/master/expcats/') && req.method === 'DELETE') return send(res, 200, Master.deleteExpCat(numId(p, '/api/master/expcats/'), ctx));

    // مخازن
    if (p === '/api/master/warehouses' && req.method === 'GET') return send(res, 200, Master.list('warehouses'));
    if (p === '/api/master/warehouses' && req.method === 'POST') return send(res, 200, Master.addWarehouse(await body(req), ctx));
    if (p.startsWith('/api/master/warehouses/') && req.method === 'PUT') return send(res, 200, Master.updateWarehouse(numId(p, '/api/master/warehouses/'), await body(req), ctx));
    if (p.startsWith('/api/master/warehouses/') && req.method === 'DELETE') return send(res, 200, Master.deleteWarehouse(numId(p, '/api/master/warehouses/'), ctx));

    // تركيبات: قائمة موسعة + تفصيل + نسخة جديدة (التعديل المباشر مرفوض 400)
    if (p === '/api/master/formulas-ref' && req.method === 'GET') return send(res, 200, Master.listFormulas());
    if (p === '/api/master/formulas-ref' && req.method === 'POST') return send(res, 200, Master.addFormula(await body(req), ctx));
    if (p.startsWith('/api/master/formulas-ref/') && p.endsWith('/make-product') && req.method === 'POST') return send(res, 200, Master.makeProduct(numId(p, '/api/master/formulas-ref/'), ctx));
    if (p.startsWith('/api/master/formulas-ref/') && p.endsWith('/new-version') && req.method === 'POST') return send(res, 200, Master.newFormulaVersion(numId(p, '/api/master/formulas-ref/'), await body(req), ctx));
    if (p.startsWith('/api/master/formulas-ref/') && req.method === 'GET') return send(res, 200, Master.getFormula(numId(p, '/api/master/formulas-ref/')));
    if (p.startsWith('/api/master/formulas-ref/') && req.method === 'PUT') return send(res, 200, Master.updateFormula(numId(p, '/api/master/formulas-ref/'), await body(req), ctx));
    if (p.startsWith('/api/master/formulas-ref/') && req.method === 'DELETE') return send(res, 200, Master.deleteFormula(numId(p, '/api/master/formulas-ref/'), ctx));

    // سجل الأرصدة (عرض فقط)
    if (p === '/api/master/opening-log' && req.method === 'GET') return send(res, 200, Master.list('opening_log'));

    // ---- المشتريات ----
    if (p === '/api/procurement/meta' && req.method === 'GET') return send(res, 200, Proc.meta());
    if (p === '/api/procurement/kpi' && req.method === 'GET') return send(res, 200, Proc.kpi());
    if (p === '/api/procurement/orders' && req.method === 'GET') return send(res, 200, Proc.listOrders());
    if (p === '/api/procurement/orders' && req.method === 'POST') return send(res, 200, Proc.addOrder(await body(req), ctx));
    if (p.startsWith('/api/procurement/orders/') && p.endsWith('/submit') && req.method === 'POST') return send(res, 200, Proc.submitOrder(numId(p, '/api/procurement/orders/'), ctx));
    if (p.startsWith('/api/procurement/orders/') && p.endsWith('/decide') && req.method === 'POST') return send(res, 200, Proc.decideOrder(numId(p, '/api/procurement/orders/'), await body(req), ctx));
    if (p.startsWith('/api/procurement/orders/') && req.method === 'GET') return send(res, 200, Proc.getOrder(numId(p, '/api/procurement/orders/')));
    if (p.startsWith('/api/procurement/orders/') && req.method === 'PUT') return send(res, 200, Proc.updateOrder(numId(p, '/api/procurement/orders/'), await body(req), ctx));
    if (p.startsWith('/api/procurement/orders/') && req.method === 'DELETE') return send(res, 200, Proc.deleteOrder(numId(p, '/api/procurement/orders/'), ctx));
    if (p === '/api/procurement/deposits' && req.method === 'GET') return send(res, 200, Proc.listDeposits(url.searchParams.get('order_id')));
    if (p === '/api/procurement/statement' && req.method === 'GET') return send(res, 200, Proc.statement(url.searchParams.get('order_id'), url.searchParams.get('supplier_id')));
    if (p === '/api/procurement/supplier-activity' && req.method === 'GET') return send(res, 200, Proc.supplierActivity(url.searchParams.get('supplier_id'), url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/procurement/suppliers-summary' && req.method === 'GET') return send(res, 200, Proc.suppliersSummary(url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/procurement/deposits' && req.method === 'POST') return send(res, 200, Proc.addDeposit(await body(req), ctx));
    if (p === '/api/procurement/payments' && req.method === 'POST') return send(res, 200, Proc.addPayment(await body(req), ctx));
    if (p.startsWith('/api/procurement/deposits/') && req.method === 'PUT') return send(res, 200, Proc.updateDeposit(numId(p, '/api/procurement/deposits/'), await body(req), ctx));
    if (p.startsWith('/api/procurement/deposits/') && req.method === 'DELETE') return send(res, 200, Proc.deleteDeposit(numId(p, '/api/procurement/deposits/'), ctx));
    if (p === '/api/procurement/confirmations' && req.method === 'GET') return send(res, 200, Proc.listConfirmations(url.searchParams.get('order_id')));
    if (p === '/api/procurement/confirmations' && req.method === 'POST') return send(res, 200, Proc.addConfirmation(await body(req), ctx));
    if (p.startsWith('/api/procurement/confirmations/') && req.method === 'GET') return send(res, 200, Proc.getConfirmation(numId(p, '/api/procurement/confirmations/')));

    // ---- الجودة: سجل فحص الدفعات ----
    if (p === '/api/quality/kpi' && req.method === 'GET') return send(res, 200, Quality.kpi());
    if (p === '/api/quality/lots' && req.method === 'GET') return send(res, 200, Quality.list(url.searchParams.get('status')));
    if (p === '/api/quality/decide' && req.method === 'POST') return send(res, 200, Quality.decide(await body(req), ctx));

    // ---- المخزون: دفتر FEFO + تحويل + جرد + تلف ----
    if (p === '/api/inventory/meta' && req.method === 'GET') return send(res, 200, Inv.meta());
    if (p === '/api/inventory/kpi' && req.method === 'GET') return send(res, 200, Inv.kpi());
    if (p === '/api/inventory/balance' && req.method === 'GET') return send(res, 200, Inv.balance());
    if (p === '/api/inventory/lots' && req.method === 'GET') return send(res, 200, Inv.lots());
    if (p === '/api/inventory/movements' && req.method === 'GET') return send(res, 200, Inv.movements(url.searchParams.get('from'), url.searchParams.get('to'), url.searchParams.get('q')));
    if (p === '/api/inventory/transfer' && req.method === 'POST') return send(res, 200, Inv.transfer(await body(req), ctx));
    if (p === '/api/inventory/counts' && req.method === 'GET') return send(res, 200, Inv.listCounts());
    if (p === '/api/inventory/counts' && req.method === 'POST') return send(res, 200, Inv.addCount(await body(req), ctx));
    if (p.startsWith('/api/inventory/counts/') && p.endsWith('/approve') && req.method === 'POST') return send(res, 200, Inv.approveCount(numId(p, '/api/inventory/counts/'), ctx));
    if (p.startsWith('/api/inventory/counts/') && req.method === 'PUT') return send(res, 200, Inv.updateCount(numId(p, '/api/inventory/counts/'), await body(req), ctx));
    if (p === '/api/inventory/wastes' && req.method === 'GET') return send(res, 200, Inv.listWastes());
    if (p === '/api/inventory/wastes' && req.method === 'POST') return send(res, 200, Inv.addWaste(await body(req), ctx));
    if (p.startsWith('/api/inventory/wastes/') && p.endsWith('/confirm') && req.method === 'POST') return send(res, 200, Inv.confirmWaste(numId(p, '/api/inventory/wastes/'), ctx));
    if (p.startsWith('/api/inventory/wastes/') && req.method === 'PUT') return send(res, 200, Inv.updateWaste(numId(p, '/api/inventory/wastes/'), await body(req), ctx));

    // ---- التتبع: قراءة فقط ----
    if (p === '/api/trace/kpi' && req.method === 'GET') return send(res, 200, Trace.kpi());
    if (p === '/api/trace/lots' && req.method === 'GET') return send(res, 200, Trace.lots());
    if (p.startsWith('/api/trace/forward/') && req.method === 'GET') return send(res, 200, Trace.forward(numId(p, '/api/trace/forward/')));
    if (p.startsWith('/api/trace/backward/') && req.method === 'GET') return send(res, 200, Trace.backward(numId(p, '/api/trace/backward/')));

    // ---- تركيبات الأعلاف: تكلفة حية (قراءة فقط) ----
    if (p === '/api/formulas/costing' && req.method === 'GET') {
      const oh = url.searchParams.get('overhead');
      const g = k => ({ on: url.searchParams.get(k + '_on') === '1', amount: Number(url.searchParams.get(k)) });
      return send(res, 200, Formulas.costing(oh === null ? 5 : Number(oh), { bags: g('bags'), transport: g('transport'), other: g('other') }));
    }

    // ---- الإنتاج: أوامر OF + إغلاق باستهلاك وتكلفة ----
    if (p === '/api/production/kpi' && req.method === 'GET') return send(res, 200, Prod.kpi());
    if (p === '/api/production/orders' && req.method === 'GET') return send(res, 200, Prod.list());
    if (p === '/api/production/orders' && req.method === 'POST') return send(res, 200, Prod.add(await body(req), ctx));
    if (p.startsWith('/api/production/orders/') && p.endsWith('/start') && req.method === 'POST') return send(res, 200, Prod.start(numId(p, '/api/production/orders/'), ctx));
    if (p.startsWith('/api/production/orders/') && p.endsWith('/cancel') && req.method === 'POST') return send(res, 200, Prod.cancel(numId(p, '/api/production/orders/'), ctx));
    if (p.startsWith('/api/production/orders/') && p.endsWith('/close') && req.method === 'POST') return send(res, 200, Prod.close(numId(p, '/api/production/orders/'), await body(req), ctx));
    if (p.startsWith('/api/production/orders/') && req.method === 'GET') return send(res, 200, Prod.get(numId(p, '/api/production/orders/')));
    if (p.startsWith('/api/production/orders/') && req.method === 'PUT') return send(res, 200, Prod.update(numId(p, '/api/production/orders/'), await body(req), ctx));
    if (p.startsWith('/api/production/orders/') && req.method === 'DELETE') return send(res, 200, Prod.remove(numId(p, '/api/production/orders/'), ctx));
    if (p === '/api/production/lots' && req.method === 'GET') return send(res, 200, Prod.lots());

    // ---- المبيعات: فواتير SI + تحصيل + مرتجع ----
    if (p === '/api/sales/kpi' && req.method === 'GET') return send(res, 200, Sales.kpi());
    if (p === '/api/sales/intel' && req.method === 'GET') return send(res, 200, Sales.intel(url.searchParams, getCtx(req)));
    if (p === '/api/sales/availability' && req.method === 'GET') return send(res, 200, Sales.availability());
    if (p === '/api/sales/statement' && req.method === 'GET') return send(res, 200, Sales.statement(url.searchParams.get('invoice_id'), url.searchParams.get('customer_id')));
    if (p === '/api/sales/customer-activity' && req.method === 'GET') return send(res, 200, Sales.customerActivity(url.searchParams.get('customer_id'), url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/sales/customers-summary' && req.method === 'GET') return send(res, 200, Sales.customersSummary(url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/sales/customer-profile' && req.method === 'GET') return send(res, 200, Sales.customerProfile(url.searchParams.get('customer_id'), getCtx(req)));
    if (p === '/api/sales/invoices' && req.method === 'GET') return send(res, 200, Sales.listInvoices(ctx));
    if (p === '/api/sales/invoices' && req.method === 'POST') return send(res, 200, Sales.addInvoice(await body(req), ctx));
    if (p.startsWith('/api/sales/invoices/') && req.method === 'GET') return send(res, 200, Sales.getInvoice(numId(p, '/api/sales/invoices/'), ctx));
    if (p.startsWith('/api/sales/invoices/') && req.method === 'PUT') return send(res, 200, Sales.updateInvoice(numId(p, '/api/sales/invoices/'), await body(req), ctx));
    if (p.startsWith('/api/sales/invoices/') && req.method === 'DELETE') return send(res, 200, Sales.deleteInvoice(numId(p, '/api/sales/invoices/'), ctx));
    if (p.startsWith('/api/sales/invoices/') && p.endsWith('/confirm') && req.method === 'POST') return send(res, 200, Sales.confirmInvoice(numId(p, '/api/sales/invoices/'), await body(req), ctx));
    if (p === '/api/sales/receipts' && req.method === 'GET') return send(res, 200, Sales.listReceipts(url.searchParams.get('invoice_id'), ctx));
    if (p === '/api/sales/receipts' && req.method === 'POST') return send(res, 200, Sales.addReceipt(await body(req), ctx));
    if (p === '/api/sales/standalone-receipts' && req.method === 'POST') return send(res, 200, Sales.addStandaloneReceipt(await body(req), ctx));
    if (p.startsWith('/api/sales/receipts/') && req.method === 'PUT') return send(res, 200, Sales.updateReceipt(numId(p, '/api/sales/receipts/'), await body(req), ctx));
    if (p.startsWith('/api/sales/receipts/') && req.method === 'DELETE') return send(res, 200, Sales.deleteReceipt(numId(p, '/api/sales/receipts/'), ctx));
    if (p === '/api/sales/returns' && req.method === 'GET') return send(res, 200, Sales.listReturns(ctx));
    if (p === '/api/sales/returns' && req.method === 'POST') return send(res, 200, Sales.addReturn(await body(req), ctx));

    // ---- طلبيات الزبائن: مسودة ← موثقة ← محولة لفاتورة (بلا أثر مخزني/مالي) ----
    // ---- الواجهة العمومية (بلا دخول): كتالوج + طلب خارجي + تتبع ----
    if (p === '/api/public/catalog' && req.method === 'GET') return send(res, 200, Sales.publicCatalog());
    if (p === '/api/public/landing' && req.method === 'GET') return send(res, 200, Sales.publicLanding());
    if (p === '/api/public/orders/track' && req.method === 'GET') {
      try { return send(res, 200, Sales.trackOrder(url.searchParams.get('phone'), url.searchParams.get('num'))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/public/orders' && req.method === 'POST') {
      const lip = String((req.socket && req.socket.remoteAddress) || 'unknown');
      if (!extRateAllow(lip)) return send(res, 429, { error: 'طلبات كثيرة من عنوانك — حاول بعد ساعة' });
      try {
        const ip = (req.socket && req.socket.remoteAddress) || '';
        return send(res, 200, Sales.publicOrder(await body(req), ip));
      } catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    // ---- الطلبات الخارجية (إدارة داخلية بصلاحيات المبيعات) ----
    if (p === '/api/sales/ext-orders' && req.method === 'GET') return send(res, 200, Sales.listExtOrders(getCtx(req)));
    if (p === '/api/sales/ext-orders/archive' && req.method === 'POST') {
      try { return send(res, 200, Sales.archiveOldExtOrders(getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p.startsWith('/api/sales/ext-orders/') && p.endsWith('/decide') && req.method === 'POST') {
      try { return send(res, 200, Sales.decideExtOrder(numId(p, '/api/sales/ext-orders/'), await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/sales/cmd-orders' && req.method === 'GET') return send(res, 200, Sales.listCmdOrders());
    if (p === '/api/sales/cmd-orders' && req.method === 'POST') return send(res, 200, Sales.addCmdOrder(await body(req), ctx));
    if (p.startsWith('/api/sales/cmd-orders/') && p.endsWith('/document') && req.method === 'POST') return send(res, 200, Sales.documentCmdOrder(numId(p, '/api/sales/cmd-orders/'), ctx));
    if (p.startsWith('/api/sales/cmd-orders/') && p.endsWith('/convert') && req.method === 'POST') return send(res, 200, Sales.convertCmdOrder(numId(p, '/api/sales/cmd-orders/'), ctx));
    if (p.startsWith('/api/sales/cmd-orders/') && p.endsWith('/undocument') && req.method === 'POST') return send(res, 200, Sales.undocumentCmdOrder(numId(p, '/api/sales/cmd-orders/'), ctx));
    if (p.startsWith('/api/sales/cmd-orders/') && req.method === 'GET') return send(res, 200, Sales.getCmdOrder(numId(p, '/api/sales/cmd-orders/')));
    if (p.startsWith('/api/sales/cmd-orders/') && req.method === 'PUT') return send(res, 200, Sales.updateCmdOrder(numId(p, '/api/sales/cmd-orders/'), await body(req), ctx));
    if (p.startsWith('/api/sales/cmd-orders/') && req.method === 'DELETE') return send(res, 200, Sales.deleteCmdOrder(numId(p, '/api/sales/cmd-orders/'), ctx));

    // ---- الفوترة والوصولات: وثائق تبعية لفواتير البيع (نفس صلاحيات المبيعات) ----
    if (p === '/api/billing/receipts' && req.method === 'GET') return send(res, 200, Billing.listReceipts(url.searchParams.get('q'), ctx));
    if (p.startsWith('/api/billing/receipts/') && p.endsWith('/receive') && req.method === 'POST') return send(res, 200, Billing.receive(numId(p, '/api/billing/receipts/'), ctx));
    if (p.startsWith('/api/billing/receipts/') && p.endsWith('/archive') && req.method === 'POST') return send(res, 200, Billing.archive(numId(p, '/api/billing/receipts/'), ctx));
    if (p.startsWith('/api/billing/receipts/') && req.method === 'GET') return send(res, 200, Billing.getReceipt(numId(p, '/api/billing/receipts/'), ctx));
    if (p === '/api/billing/invoices' && req.method === 'GET') return send(res, 200, Billing.listInvoices(url.searchParams.get('q'), url.searchParams.get('kind'), ctx));
    if (p.startsWith('/api/billing/invoices/') && p.endsWith('/upgrade') && req.method === 'POST') return send(res, 200, Billing.upgrade(numId(p, '/api/billing/invoices/'), await body(req), ctx));
    if (p.startsWith('/api/billing/invoices/') && req.method === 'GET') return send(res, 200, Billing.getInvoice(numId(p, '/api/billing/invoices/'), ctx));
    if (p.startsWith('/api/billing/invoices/') && req.method === 'PUT') return send(res, 200, Billing.updateInvoice(numId(p, '/api/billing/invoices/'), await body(req), ctx));

    // ---- المالية والمحاسبة: مرآة تلقائية + حسابات ومصاريف ----
    if (p === '/api/finance/kpi' && req.method === 'GET') return send(res, 200, Finance.kpi(url.searchParams.get('month')));
    if (p === '/api/finance/journal' && req.method === 'GET') return send(res, 200, Finance.journal(url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/finance/debts' && req.method === 'GET') return send(res, 200, Finance.debts());
    if (p === '/api/finance/pnl' && req.method === 'GET') return send(res, 200, Finance.pnl(url.searchParams.get('month')));
    if (p === '/api/finance/trial' && req.method === 'GET') return send(res, 200, Finance.trial(url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/finance/compare' && req.method === 'GET') return send(res, 200, Finance.compare());
    if (p === '/api/finance/accounts' && req.method === 'GET') return send(res, 200, Finance.listAccounts());
    if (p === '/api/finance/accounts' && req.method === 'POST') return send(res, 200, Finance.addAccount(await body(req), ctx));
    if (p.startsWith('/api/finance/accounts/') && p.endsWith('/opening') && req.method === 'POST') return send(res, 200, Finance.setOpening(numId(p, '/api/finance/accounts/'), await body(req), ctx));
    if (p.startsWith('/api/finance/accounts/') && req.method === 'PUT') return send(res, 200, Finance.updateAccount(numId(p, '/api/finance/accounts/'), await body(req), ctx));
    if (p.startsWith('/api/finance/accounts/') && req.method === 'DELETE') return send(res, 200, Finance.deleteAccount(numId(p, '/api/finance/accounts/'), ctx));
    if (p === '/api/finance/expenses' && req.method === 'GET') return send(res, 200, Finance.listExpenses());
    if (p === '/api/finance/expenses' && req.method === 'POST') return send(res, 200, Finance.addExpense(await body(req), ctx));
    if (p.startsWith('/api/finance/expenses/') && req.method === 'PUT') return send(res, 200, Finance.updateExpense(numId(p, '/api/finance/expenses/'), await body(req), ctx));
    if (p.startsWith('/api/finance/expenses/') && req.method === 'DELETE') return send(res, 200, Finance.deleteExpense(numId(p, '/api/finance/expenses/'), ctx));
    if (p === '/api/finance/incomes' && req.method === 'GET') return send(res, 200, Finance.listIncomes());
    if (p === '/api/finance/incomes' && req.method === 'POST') return send(res, 200, Finance.addIncome(await body(req), ctx));
    if (p.startsWith('/api/finance/incomes/') && req.method === 'DELETE') return send(res, 200, Finance.deleteIncome(numId(p, '/api/finance/incomes/'), ctx));
    if (p === '/api/finance/transfers' && req.method === 'GET') return send(res, 200, Finance.listTransfers());
    if (p === '/api/finance/transfers' && req.method === 'POST') return send(res, 200, Finance.addTransfer(await body(req), ctx));
    if (p.startsWith('/api/finance/transfers/') && req.method === 'DELETE') return send(res, 200, Finance.deleteTransfer(numId(p, '/api/finance/transfers/'), ctx));

    // ---- نسخ التصميم والاسترجاع (زر الإعادة) ----
    if (p === '/api/system/design-backups' && req.method === 'GET') return send(res, 200, { data: DesignSnaps.list() });
    if (p === '/api/system/design-backups' && req.method === 'POST') {
      const b = await body(req);
      return send(res, 200, { data: DesignSnaps.save(String((b && b.label) || '').slice(0, 60) || 'نسخة يدوية') });
    }
    if (p === '/api/system/design-restore' && req.method === 'POST') {
      const b = await body(req);
      return send(res, 200, { data: DesignSnaps.restore(String((b && b.id) || '')) });
    }

    // ---- النظام: إعدادات + نسخ بيانات + سجل ----
    if (p === '/api/system/public' && req.method === 'GET') return send(res, 200, System.pub());
    if (p === '/api/system/config' && req.method === 'GET') return send(res, 200, { data: System.get() });
    if (p === '/api/system/config' && req.method === 'PUT') {
      try { return send(res, 200, System.update(await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/system/changelog' && req.method === 'GET') return send(res, 200, { data: System.get().changelog || [] });
    if (p === '/api/system/changelog' && req.method === 'POST') {
      try { return send(res, 200, System.changelogAdd(await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/system/archives' && req.method === 'GET') {
      if (getCtx(req).role !== 'admin') return send(res, 403, { error: 'للمدير فقط' });
      return send(res, 200, System.archives());
    }
    if (p === '/api/system/backup-catalog' && req.method === 'GET') {
      if (getCtx(req).role !== 'admin') return send(res, 403, { error: 'للمدير فقط' });
      return send(res, 200, System.backupCatalog());
    }
    if (p === '/api/system/data-backup' && req.method === 'GET') {
      if (getCtx(req).role !== 'admin') return send(res, 403, { error: 'للمدير فقط' });
      return send(res, 200, System.dataBackup());
    }
    if (p === '/api/system/data-backup' && req.method === 'POST') {
      try { return send(res, 200, System.dataBackup((await body(req)).modules)); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/system/data-restore' && req.method === 'POST') {
      try { return send(res, 200, System.dataRestore(await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    // لقطات الخادم: حفظ مسمى + قائمة + استعادة + تنزيل + حذف
    if (p === '/api/system/snapshots' && req.method === 'GET') {
      try { return send(res, 200, System.snapList(getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/system/snapshots' && req.method === 'POST') {
      try { return send(res, 200, System.snapSave(await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/system/snapshot-restore' && req.method === 'POST') {
      try { return send(res, 200, System.snapRestore(await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/system/snapshot-delete' && req.method === 'POST') {
      try { return send(res, 200, System.snapDelete(await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/system/snapshot-file' && req.method === 'GET') {
      try { return send(res, 200, System.snapGet({ id: url.searchParams.get('id') }, getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    // أزرار التصفير المؤقتة — للمدير العام فقط (فحص مزدوج: بوابة backup + داخل الدالة)
    if (p === '/api/system/reset-sales' && req.method === 'POST') {
      try { return send(res, 200, Reset.sales(await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }
    if (p === '/api/system/reset-procurement' && req.method === 'POST') {
      try { return send(res, 200, Reset.procurement(await body(req), getCtx(req))); }
      catch (e) { return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' }); }
    }

    // ---- الموظفون: حضور + سلف + كشوف + دفع ----
    if (p === '/api/employees/kpi' && req.method === 'GET') return send(res, 200, Emp.kpi(url.searchParams.get('month')));
    if (p === '/api/employees/profiles' && req.method === 'GET') return send(res, 200, Emp.listProfiles());
    if (p === '/api/employees/profiles' && req.method === 'POST') return send(res, 200, Emp.saveProfile(await body(req), ctx));
    if (p === '/api/employees/attendance' && req.method === 'GET') return send(res, 200, Emp.listAttendance(url.searchParams.get('date')));
    if (p === '/api/employees/attendance' && req.method === 'POST') return send(res, 200, Emp.mark(await body(req), ctx));
    if (p === '/api/employees/attendance/bulk' && req.method === 'POST') return send(res, 200, Emp.bulk(await body(req), ctx));
    if (p === '/api/employees/advances' && req.method === 'GET') return send(res, 200, Emp.listAdvances());
    if (p === '/api/employees/advances' && req.method === 'POST') return send(res, 200, Emp.addAdvance(await body(req), ctx));
    if (p.startsWith('/api/employees/advances/') && req.method === 'DELETE') return send(res, 200, Emp.deleteAdvance(numId(p, '/api/employees/advances/'), ctx));
    if (p === '/api/employees/adjustments' && req.method === 'GET') return send(res, 200, Emp.listAdjustments());
    if (p === '/api/employees/adjustments' && req.method === 'POST') return send(res, 200, Emp.addAdjustment(await body(req), ctx));
    if (p.startsWith('/api/employees/adjustments/') && req.method === 'DELETE') return send(res, 200, Emp.deleteAdjustment(numId(p, '/api/employees/adjustments/'), ctx));
    if (p === '/api/employees/payrolls' && req.method === 'GET') return send(res, 200, Emp.listPayrolls(url.searchParams.get('month')));
    if (p === '/api/employees/worker-activity' && req.method === 'GET') return send(res, 200, Emp.workerActivity(url.searchParams.get('worker_id'), url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/employees/workers-summary' && req.method === 'GET') return send(res, 200, Emp.workersSummary(url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/employees/payrolls' && req.method === 'POST') return send(res, 200, Emp.generate(await body(req), ctx));
    if (p.startsWith('/api/employees/payrolls/') && p.endsWith('/pay') && req.method === 'POST') return send(res, 200, Emp.pay(numId(p, '/api/employees/payrolls/'), await body(req), ctx));
    if (p.startsWith('/api/employees/payrolls/') && req.method === 'DELETE') return send(res, 200, Emp.deletePayroll(numId(p, '/api/employees/payrolls/'), ctx));

    // ---- التقارير: قراءة فقط ----
    if (p === '/api/reports/stock' && req.method === 'GET') return send(res, 200, Rep.stock(url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/reports/procurement' && req.method === 'GET') return send(res, 200, Rep.procurement(url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/reports/sales' && req.method === 'GET') return send(res, 200, Rep.sales(url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/reports/finance' && req.method === 'GET') return send(res, 200, Rep.finance(url.searchParams.get('from'), url.searchParams.get('to')));
    if (p === '/api/reports/statement' && req.method === 'GET') return send(res, 200, Rep.statement(url.searchParams.get('type'), url.searchParams.get('id')));
    if (p === '/api/reports/production' && req.method === 'GET') return send(res, 200, Rep.production(url.searchParams.get('from'), url.searchParams.get('to'), url.searchParams.get('a'), url.searchParams.get('b'), url.searchParams.get('overhead')));

    return send(res, 404, { error: 'غير موجود' });
  } catch (e) {
    return send(res, (e && e.code) || 500, { error: (e && e.message) || 'خطأ داخلي' });
  } finally {
    if (__unlock) { try { __unlock(); } catch {} }
  }
});

server.listen(PORT, () => console.log('Dar Al-Alef V2 on http://localhost:' + PORT));

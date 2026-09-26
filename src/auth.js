// المصادقة والصلاحيات: مستخدمون + أدوار بمصفوفة (دور × قسم × إجراء) + جلسات + أحداث
// القاعدة: المصفوفة هي المرجع الوحيد — كل حراس الأقسام يستدعون Auth.can
const crypto = require('node:crypto');
const jstore = require('./jstore');

const db = jstore('users.json', {
  seq: { user: 1, role: 1, session: 1, event: 1 },
  users: [], roles: [], sessions: [], events: [], fails: []
});
const now = () => new Date().toISOString();
const SESSION_HOURS = 12;
const LOCK_AFTER = 5;
const LOCK_MIN = 15;

function err(msg, code) { throw Object.assign(new Error(msg), { code: code || 400 }); }

// الأقسام والإجراءات (أسماء الإجراءات تطابق مفاهيم الأقسام لا CRUD عام)
const SECTIONS = {
  master: { label: 'البيانات الأساسية', actions: ['view', 'item', 'party', 'opening'] },
  procurement: { label: 'المشتريات', actions: ['view', 'order', 'approve', 'deposit', 'confirm'] },
  quality: { label: 'الجودة', actions: ['view', 'decide'] },
  inventory: { label: 'المخزون', actions: ['view', 'move', 'approve'] },
  trace: { label: 'التتبع', actions: ['view'] },
  formulas: { label: 'التركيبات', actions: ['view'] },
  production: { label: 'الإنتاج', actions: ['view', 'order', 'execute'] },
  sales: { label: 'المبيعات', actions: ['view', 'invoice', 'receipt', 'return'] },
  finance: { label: 'المالية', actions: ['view', 'account', 'expense', 'income'] },
  employees: { label: 'الموظفون', actions: ['view', 'attend', 'pay'] },
  reports: { label: 'التقارير', actions: ['view'] },
  users: { label: 'المستخدمون', actions: ['view', 'manage'] },
  system: { label: 'النظام', actions: ['view', 'backup', 'config'] }
};
const ACTION_LABELS = {
  view: 'عرض', item: 'بطاقات المواد', party: 'الجهات والمخازن', opening: 'الأرصدة الافتتاحية',
  order: 'الطلبات/الأوامر', approve: 'اعتماد', deposit: 'العربون', confirm: 'التأكيد',
  decide: 'القرار', move: 'الحركات', execute: 'التنفيذ',
  invoice: 'الفواتير', receipt: 'التحصيل', return: 'المرتجع',
  account: 'الحسابات', expense: 'المصاريف', income: 'إيرادات أخرى',
  attend: 'الحضور', pay: 'الرواتب',
  manage: 'الإدارة', backup: 'النسخ', config: 'الإعدادات'
};
// البذر المطابق لقواعد الأقسام المتفق عليها سابقاً (نفس السلوك، مصدر جديد)
function seedPerms() {
  const out = { admin: {}, storekeeper: {}, accountant: {}, salesman: {} };
  for (const r of Object.keys(out)) {
    out[r] = {};
    for (const sec of Object.keys(SECTIONS)) {
      out[r][sec] = {};
      for (const a of SECTIONS[sec].actions) out[r][sec][a] = false;
    }
  }
  const all = r => { for (const sec of Object.keys(SECTIONS)) for (const a of SECTIONS[sec].actions) out[r][sec][a] = true; };
  all('admin');
  const S = out.storekeeper, A = out.accountant, V = out.salesman;
  // مندوب المبيعات: بطاقات العرض (أصناف/مخزون) + فواتيره وتحصيلاته فقط (النطاق يُفرض في sales/billing)
  V.master.view = true;
  V.inventory.view = true;
  V.sales.view = V.sales.invoice = V.sales.receipt = true;
  for (const a of SECTIONS.master.actions) S.master[a] = (a === 'view');
  S.procurement.view = S.procurement.order = true;
  S.procurement.confirm = true;
  S.quality.view = S.quality.decide = true;
  S.inventory.view = S.inventory.move = true;
  S.trace.view = S.formulas.view = S.reports.view = S.system.view = true;
  S.production.view = S.production.order = S.production.execute = true;
  S.sales.view = true;
  S.finance.view = true;
  S.employees.view = S.employees.attend = true;
  A.master.view = true;
  A.procurement.view = A.procurement.order = A.procurement.deposit = A.procurement.confirm = true;
  A.quality.view = A.inventory.view = A.trace.view = A.formulas.view = A.reports.view = A.system.view = true;
  A.production.view = true;
  A.sales.view = A.sales.invoice = A.sales.receipt = true;
  A.finance.view = A.finance.account = A.finance.expense = A.finance.income = true;
  A.employees.view = A.employees.pay = true;
  return out;
}

function load() {
  const d = db.load();
  if (!Array.isArray(d.users)) d.users = [];
  if (!Array.isArray(d.roles)) d.roles = [];
  if (!Array.isArray(d.sessions)) d.sessions = [];
  if (!Array.isArray(d.events)) d.events = [];
  if (!Array.isArray(d.fails)) d.fails = [];
  d.seq = d.seq || {};
  for (const k of ['user', 'role', 'session', 'event']) {
    if (!Number.isInteger(d.seq[k]) || d.seq[k] < 1) d.seq[k] = 1;
  }
  // تنظيف الجلسات المنتهية أولاً بأول لمنع تضخم users.json
  try {
    const n0 = d.sessions.length;
    const nowMs = Date.now();
    d.sessions = d.sessions.filter(s => s && Date.parse(s.expires) > nowMs);
    if (d.sessions.length !== n0) { try { db.save(d); } catch (e) {} }
  } catch (e) {}
  // ترحيل إضافي: أي إجراء جديد يُمنح لدور المدير تلقائياً، ويُضاف مغلقاً لباقي الأدوار (لا يُسحب شيء أبداً هنا)
  const adm = d.roles.find(r => r.id === 'admin');
  if (adm) {
    adm.perms = adm.perms || {};
    let touched = false;
    for (const sec of Object.keys(SECTIONS)) {
      adm.perms[sec] = adm.perms[sec] || {};
      for (const a of SECTIONS[sec].actions) {
        if (adm.perms[sec][a] === undefined) { adm.perms[sec][a] = true; touched = true; }
      }
    }
    for (const r of d.roles) {
      if (r.id === 'admin') continue;
      r.perms = r.perms || {};
      for (const sec of Object.keys(SECTIONS)) {
        r.perms[sec] = r.perms[sec] || {};
        for (const a of SECTIONS[sec].actions) {
          if (r.perms[sec][a] === undefined) { r.perms[sec][a] = false; touched = true; }
        }
      }
    }
    // سياسة البيانات الأساسية: الإضافة والتعديل والحذف للمدير العام فقط — أي دور آخر قراءة فقط
    for (const r of d.roles) {
      if (r.id === 'admin') continue;
      r.perms = r.perms || {};
      const m = r.perms.master || {};
      if (m.item || m.party || m.opening) { m.item = false; m.party = false; m.opening = false; touched = true; }
      r.perms.master = m;
    }
    if (touched) db.save(d);
  }
  return d;
}
function hashSha256(pw, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pw, 'utf8').digest('hex');
}
// ترقية أمنية: scrypt مع توافق رجعي — الحسابات القديمة sha256 تُرقّى تلقائياً عند أول دخول ناجح
function hashScrypt(pw, salt) {
  return crypto.scryptSync(String(pw || ''), String(salt || ''), 64).toString('hex');
}
function hashPw(pw, salt) {
  return hashScrypt(pw, salt);
}
function safeEq(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}
function verifyPw(pw, u) {
  if (!u || !u.salt || !u.hash) return false;
  if (u.algo === 'scrypt') return safeEq(hashScrypt(pw, u.salt), u.hash);
  // حساب قديم sha256 — قارن بالطريقة القديمة (ثم تُرقّى عند الدخول)
  const oldOk = safeEq(hashSha256(String(pw || ''), u.salt), u.hash)
    || hashSha256(String(pw || ''), u.salt) === u.hash;
  return oldOk;
}
function event(d, kind, username, detail, ip) {
  d.events.push({ id: d.seq.event++, kind, username: username || '', detail: detail || '', ip: ip || '', at: now() });
  if (d.events.length > 1000) d.events = d.events.slice(-1000);
}
function pruneFails(d) {
  const cut = Date.now() - LOCK_MIN * 60000;
  d.fails = d.fails.filter(f => Date.parse(f.at) > cut);
  // سقف صلب: يمنع تضخم users.json تحت هجوم إغراق (الأحدث يُحفظ)
  if (d.fails.length > 500) d.fails = d.fails.slice(-500);
}
// توحيد اسم الدخول: إزالة الخفية والتشكيل والتطويل + طيّ المتشابهات (أإآٱ→ا، ؤ→و، ئ→ي، ة→ه، ى→ي)
// يمنع حسابين يبدوان متطابقين (مثال: أحمد/احمد، فاطمة/فاطمه) — اللاتينية تمر كما هي
function canonUser(s) {
  let v = String(s == null ? '' : s).trim().normalize('NFKC');
  v = v.replace(/[\u200B-\u200D\u200E\u200F\uFEFF]/g, '').replace(/ـ/g, '').replace(/[\u064B-\u0652]/g, '');
  v = v.replace(/[أإآٱ]/g, 'ا').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  return v;
}
// سياسة اسم الدخول: حروف عربية/لاتينية + أرقام (عربية ٠-٩ أو لاتينية) — 3-32 حرفاً، بلا رموز ولا مسافات
const USER_RE = /^[\p{Script=Arabic}A-Za-z0-9]{3,32}$/u;
function roleOf(d, roleId) { return d.roles.find(r => r.id === roleId); }
function adminsWithManage(d) {
  return d.users.filter(u => u.active !== false && (() => {
    const r = roleOf(d, u.role);
    return r && r.perms && r.perms.users && r.perms.users.manage;
  })());
}

const Auth = {
  SECTIONS, ACTION_LABELS, SESSION_HOURS,

  can(roleId, sec, act) {
    const d = load();
    const r = roleOf(d, roleId);
    return !!(r && r.perms && r.perms[sec] && r.perms[sec][act]);
  },
  myPerms(roleId) {
    const d = load();
    const r = roleOf(d, roleId);
    const out = {};
    for (const sec of Object.keys(SECTIONS)) {
      out[sec] = {};
      for (const a of SECTIONS[sec].actions) out[sec][a] = !!(r && r.perms && r.perms[sec] && r.perms[sec][a]);
    }
    return { role: roleId, perms: out };
  },

  seed() {
    const d = load();
    let touched = false;
    if (!d.roles.length) {
      const P = seedPerms();
      const mk = (id, label) => ({ id, label, system: true, perms: P[id], updated_at: now() });
      d.roles.push(mk('admin', 'المدير العام'), mk('storekeeper', 'مدير المخزون'), mk('accountant', 'المحاسب'), mk('salesman', 'مندوب المبيعات'));
      touched = true;
    }
    // ترحيل: دور المندوب يُضاف للقواعد القديمة (صلاحياته من البذر الحالي)
    if (d.roles.length && !d.roles.some(r => r.id === 'salesman')) {
      const P = seedPerms();
      d.roles.push({ id: 'salesman', label: 'مندوب المبيعات', system: true, perms: P.salesman, updated_at: now() });
      touched = true;
    }
    if (!d.users.length) {
      const mk = (username, password, role, label) => {
        const salt = crypto.randomBytes(16).toString('hex');
        d.users.push({ id: d.seq.user++, username, salt, hash: hashScrypt(password, salt), algo: 'scrypt', role, label, active: true, must_change: true, worker_id: null, created_at: now() });
      };
      mk('admin', 'admin123', 'admin', 'المدير العام');
      mk('store', 'store123', 'storekeeper', 'مدير المخزون');
      mk('accountant', 'acc123', 'accountant', 'المحاسب');
      mk('salesman', 'sales123', 'salesman', 'مندوب المبيعات');
      touched = true;
    }
    if (touched) db.save(d);
    return { roles: d.roles.length, users: d.users.length };
  },

  login(username, password, ip, ua, opts) {
    const d = load();
    const name = canonUser(username);
    pruneFails(d);
    const fails = d.fails.filter(f => f.username === name).length;
    if (fails >= LOCK_AFTER) {
      event(d, 'login_locked', name, 'قفل مؤقت', ip);
      db.save(d);
      err('الحساب مقفل مؤقتاً بعد محاولات فاشلة — انتظر 15 دقيقة', 403);
    }
    const u = d.users.find(x => canonUser(x.username) === name);
    if (!u || u.active === false || !verifyPw(String(password || ''), u)) {
      d.fails.push({ username: name, at: now(), ip: ip || '' });
      event(d, 'login_fail', name, '', ip);
      db.save(d);
      err('بيانات الدخول غير صحيحة', 401);
    }
    // ترقية تلقائية من sha256 إلى scrypt عند أول دخول ناجح
    if (u.algo !== 'scrypt') {
      u.salt = crypto.randomBytes(16).toString('hex');
      u.hash = hashScrypt(String(password || ''), u.salt);
      u.algo = 'scrypt';
    }
    // إلزام تغيير كلمات المصنع: من ما زال يستعمل كلمة المصنع يُطالب بالتغيير (بلا قفل — يغيّرها من حسابه)
    try {
      const FACTORY = { admin: 'admin123', store: 'store123', accountant: 'acc123', salesman: 'sales123' };
      if (FACTORY[u.username] && !u.must_change && verifyPw(FACTORY[u.username], u)) u.must_change = true;
    } catch {}
    d.fails = d.fails.filter(f => f.username !== name);
    // جلسة واحدة لكل حساب: إن كانت هناك جلسة نشطة (غير منتهية) لنفس المستخدم
    // نرفض الدخول الجديد برمز 409 مع وصف الجلسة القائمة — والدخول لا يتم إلا
    // بتأكيد صريح (force) يُخرج الجلسة القديمة أولاً. كلمة المرور صحيحة هنا،
    // لذلك لا تُحتسب محاولة فاشلة ولا تُقفل الحساب.
    const nowMs = Date.now();
    const live = d.sessions.filter(s => s && s.user_id === u.id && Date.parse(s.expires) > nowMs);
    const force = !!(opts && (opts.force === true || opts.force === 'true' || opts.force === 1 || opts.force === '1'));
    if (live.length && !force) {
      const cur = live.slice().sort((a, b) => (String(a.created) < String(b.created) ? 1 : -1))[0];
      event(d, 'login_busy', u.username, 'جلسة نشطة من ' + (cur.ip || '؟'), ip);
      db.save(d);
      const e = new Error('هذا الحساب مستعمل الآن على جهاز آخر — أكّد إخراج الجلسة الأخرى للدخول');
      e.code = 409;
      e.details = {
        needConfirm: true,
        sessions: live.slice(0, 3).map(s => ({
          ip: s.ip || '', ua: String(s.ua || '').slice(0, 80),
          created: String(s.created || '').slice(0, 16).replace('T', ' '),
          expires: String(s.expires || '').slice(0, 16).replace('T', ' ')
        }))
      };
      throw e;
    }
    if (live.length && force) {
      d.sessions = d.sessions.filter(s => !(s && s.user_id === u.id));
      event(d, 'login_kick', u.username, 'أُخرجت ' + live.length + ' جلسة بتأكيد الدخول الجديد', ip);
    }
    const token = crypto.randomBytes(32).toString('hex');
    d.sessions.push({
      id: d.seq.session++, token, user_id: u.id, username: u.username, role: u.role,
      created: now(), expires: new Date(Date.now() + SESSION_HOURS * 3600000).toISOString(),
      ip: ip || '', ua: String(ua || '').slice(0, 120)
    });
    event(d, 'login_ok', u.username, u.role, ip);
    db.save(d);
    const r = roleOf(d, u.role);
    return { token, user: { username: u.username, role: u.role, label: (r && r.label) || u.label || u.role, must_change: !!u.must_change } };
  },

  logout(token) {
    const d = load();
    const i = d.sessions.findIndex(s => s.token === token);
    if (i >= 0) {
      event(d, 'logout', d.sessions[i].username, '', '');
      d.sessions.splice(i, 1);
      db.save(d);
    }
    return { ok: true };
  },

  ctxFromReq(req) {
    const h = (req.headers && req.headers.authorization) || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!t) return { user: 'guest', role: 'guest', uid: null };
    const d = load();
    const s = d.sessions.find(x => x.token === t);
    if (!s) return { user: 'guest', role: 'guest', uid: null };
    if (Date.parse(s.expires) < Date.now()) {
      d.sessions = d.sessions.filter(x => x.token !== t);
      db.save(d);
      return { user: 'guest', role: 'guest', uid: null };
    }
    return { user: s.username, role: s.role, uid: s.user_id };
  },

  // ---- إدارة المستخدمين (manage) ----
  _needManage(ctx) {
    if (!this.can(ctx.role, 'users', 'manage')) err('إدارة المستخدمين للمدير فقط', 403);
  },
  _needView(ctx) {
    if (!this.can(ctx.role, 'users', 'view')) err('صفحة المستخدمين للمدير فقط', 403);
  },
  listUsers(ctx) {
    this._needView(ctx);
    const d = load();
    const md = require('./store').load();
    return {
      data: d.users.map(u => {
        const r = roleOf(d, u.role);
        const w = (md.workers || []).find(x => x.id === u.worker_id);
        return { id: u.id, username: u.username, role: u.role, role_label: (r && r.label) || u.role, active: u.active !== false, must_change: !!u.must_change, worker_id: u.worker_id || null, worker_name: w ? w.name : '', created_at: u.created_at };
      })
    };
  },
  addUser(b, ctx) {
    this._needManage(ctx);
    const name = canonUser(b.username);
    if (!USER_RE.test(name)) err('اسم الدخول: 3-32 حرفاً (حروف عربية/لاتينية وأرقام فقط، بلا رموز)');
    if (String(b.password || '').length < 4) err('كلمة المرور 4 أحرف على الأقل');
    const d = load();
    if (d.users.some(u => canonUser(u.username) === name)) err('اسم الدخول مستعمل');
    if (!roleOf(d, b.role)) err('الدور غير موجود');
    let worker_id = null;
    if (b.worker_id !== undefined && b.worker_id !== null && b.worker_id !== '') {
      const md = require('./store').load();
      const w = (md.workers || []).find(x => x.id === Number(b.worker_id));
      if (!w) err('الموظف غير موجود');
      worker_id = w.id;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const row = { id: d.seq.user++, username: name, salt, hash: hashScrypt(String(b.password), salt), algo: 'scrypt', role: b.role, label: '', active: b.active === undefined ? true : !!b.active, must_change: true, worker_id, created_at: now() };
    d.users.push(row);
    event(d, 'user_add', ctx.user, name, '');
    db.save(d);
    return { data: { id: row.id, username: name } };
  },
  updateUser(id, b, ctx) {
    this._needManage(ctx);
    const d = load();
    const u = d.users.find(x => x.id === Number(id));
    if (!u) err('المستخدم غير موجود', 404);
    if (b.active !== undefined) {
      u.active = !!b.active;
      if (!u.active && u.username === ctx.user) err('لا تعطل حسابك بنفسك');
    }
    if (b.role !== undefined) {
      if (!roleOf(d, b.role)) err('الدور غير موجود');
      if (u.username === ctx.user && b.role !== u.role) {
        const r = roleOf(d, b.role);
        if (!(r && r.perms && r.perms.users && r.perms.users.manage)) err('لا تجرّد نفسك من الإدارة');
      }
      u.role = b.role;
    }
    if (b.worker_id !== undefined) {
      if (b.worker_id === null || b.worker_id === '') u.worker_id = null;
      else {
        const md = require('./store').load();
        const w = (md.workers || []).find(x => x.id === Number(b.worker_id));
        if (!w) err('الموظف غير موجود');
        u.worker_id = w.id;
      }
    }
    if (adminsWithManage(d).filter(x => x.active !== false).length === 0) err('ممنوع: يجب بقاء مدير نشط واحد على الأقل');
    db.save(d);
    return { data: { id: u.id } };
  },
  deleteUser(id, ctx) {
    this._needManage(ctx);
    const d = load();
    const i = d.users.findIndex(x => x.id === Number(id));
    if (i < 0) err('المستخدم غير موجود', 404);
    if (d.users[i].username === ctx.user) err('لا تحذف حسابك بنفسك');
    const gone = d.users[i];
    d.users.splice(i, 1);
    d.sessions = d.sessions.filter(s => s.user_id !== gone.id);
    d.fails = d.fails.filter(f => f.username !== gone.username);
    if (adminsWithManage(d).filter(x => x.active !== false).length === 0) err('ممنوع: يجب بقاء مدير نشط واحد على الأقل');
    event(d, 'user_del', ctx.user, gone.username, '');
    db.save(d);
    return { ok: true };
  },
  resetPassword(id, b, ctx) {
    this._needManage(ctx);
    if (String(b.password || '').length < 4) err('كلمة المرور 4 أحرف على الأقل');
    const d = load();
    const u = d.users.find(x => x.id === Number(id));
    if (!u) err('المستخدم غير موجود', 404);
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = hashScrypt(String(b.password), u.salt);
    u.algo = 'scrypt';
    u.must_change = true;
    d.sessions = d.sessions.filter(s => s.user_id !== u.id);
    event(d, 'pwd_reset', ctx.user, u.username, '');
    db.save(d);
    return { ok: true };
  },
  changePassword(b, ctx) {
    if (ctx.role === 'guest') err('سجل الدخول أولاً', 401);
    const d = load();
    const u = d.users.find(x => x.username === ctx.user);
    if (!u) err('غير موجود', 404);
    if (!verifyPw(String(b.old || ''), u)) err('كلمة المرور الحالية غير صحيحة', 403);
    if (String(b.new || '').length < 6) err('الجديدة 6 أحرف على الأقل');
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = hashScrypt(String(b.new), u.salt);
    u.algo = 'scrypt';
    u.must_change = false;
    event(d, 'pwd_change', u.username, '', '');
    db.save(d);
    return { ok: true };
  },

  // ---- الأدوار ----
  listRoles(ctx) {
    this._needView(ctx);
    const d = load();
    return {
      data: d.roles.map(r => ({ ...r, users: d.users.filter(u => u.role === r.id).length }))
    };
  },
  addRole(b, ctx) {
    this._needManage(ctx);
    const label = String(b.label || '').trim();
    if (!label) err('اسم الدور مطلوب');
    const d = load();
    const perms = {};
    for (const sec of Object.keys(SECTIONS)) {
      perms[sec] = {};
      for (const a of SECTIONS[sec].actions) perms[sec][a] = false;
    }
    const row = { id: 'r' + (d.seq.role++), label, system: false, perms, updated_at: now() };
    d.roles.push(row);
    db.save(d);
    return { data: { id: row.id } };
  },
  updateRole(id, b, ctx) {
    this._needManage(ctx);
    const d = load();
    const r = roleOf(d, String(id));
    if (!r) err('الدور غير موجود', 404);
    if (b.label !== undefined) {
      if (!String(b.label).trim()) err('اسم الدور مطلوب');
      r.label = String(b.label).trim();
    }
    if (b.perms !== undefined) {
      // سياسة البيانات الأساسية: لا منح لتعديلها خارج المدير العام — الرفض الصريح أوضح من التجريد الصامت
      if (String(id) !== 'admin' && b.perms.master && (b.perms.master.item || b.perms.master.party || b.perms.master.opening)) {
        err('صلاحيات البيانات الأساسية (إضافة/تعديل/حذف) للمدير العام فقط — تُمنح القراءة فقط لباقي الأدوار');
      }
      for (const sec of Object.keys(b.perms)) {
        if (!SECTIONS[sec]) err('قسم غير صالح: ' + sec);
        for (const a of Object.keys(b.perms[sec])) {
          if (!SECTIONS[sec].actions.includes(a)) err('إجراء غير صالح: ' + sec + '.' + a);
          r.perms[sec][a] = !!b.perms[sec][a];
        }
      }
      r.updated_at = now();
    }
    if (adminsWithManage(d).filter(x => x.active !== false).length === 0) err('ممنوع: يجب بقاء مدير نشط واحد على الأقل');
    event(d, 'role_change', ctx.user, r.id, '');
    db.save(d);
    return { data: { id: r.id } };
  },
  deleteRole(id, ctx) {
    this._needManage(ctx);
    const d = load();
    const i = d.roles.findIndex(x => x.id === String(id));
    if (i < 0) err('الدور غير موجود', 404);
    if (d.roles[i].system) err('أدوار النظام لا تُحذف');
    if (d.users.some(u => u.role === d.roles[i].id)) err('الدور مستعمل — انقل مستخدميه أولاً');
    d.roles.splice(i, 1);
    db.save(d);
    return { ok: true };
  },

  // ---- التدقيق المدمج + KPIs ----
  auditView(ctx, limit) {
    this._needView(ctx);
    const d = load();
    const rows = d.events.map(e => ({ at: e.at, by: e.username, action: e.kind, detail: e.detail }));
    try {
      const md = require('./store').load();
      for (const a of (md.audit || []).slice(-100)) rows.push({ at: a.at, by: a.by, action: 'master.' + a.action, detail: a.entity + ' #' + a.ref_id });
    } catch {}
    try {
      const pd = require('./jstore')('procurement.json', { audit: [] }).load();
      for (const a of (pd.audit || []).slice(-100)) rows.push({ at: a.at, by: a.by, action: 'proc.' + a.action, detail: '#' + a.ref_id });
    } catch {}
    rows.sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1));
    return { data: rows.slice(0, limit || 200) };
  },
  kpi(ctx) {
    this._needView(ctx);
    const d = load();
    const today = now().slice(0, 10);
    const fails = d.fails.filter(f => String(f.at).slice(0, 10) === today).length;
    const logins = d.events.filter(e => e.kind === 'login_ok').sort((a, b) => (a.at < b.at ? 1 : -1));
    const lastRole = d.roles.slice().sort((a, b) => (String(a.updated_at || '') < String(b.updated_at || '') ? 1 : -1))[0];
    return {
      data: {
        active: d.users.filter(u => u.active !== false).length,
        failedToday: fails,
        lastLogin: logins[0] ? { user: logins[0].username, at: String(logins[0].at).slice(0, 16).replace('T', ' ') } : null,
        roles: d.roles.length,
        lastPermChange: lastRole ? String(lastRole.updated_at || '').slice(0, 16).replace('T', ' ') : null
      }
    };
  }
};

Auth.seed();
module.exports = Auth;

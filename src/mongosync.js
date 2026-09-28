// مرآة MongoDB لملفات البيانات — الملفات مرجع فوري، ومونغو نسخة باقية ضد مسح رندر
// التصميم الآمن:
// - الدفع عند كل حفظ (بعد ثانيتين) + دفع خلفي كل 9 دقائق حتى لو لا أحد فاتح الموقع
// - حماية من الفراغ: ممنوع دفع ملف مصنعي/فارغ فوق سحابة مليانة، وممنوع سحب فارغ فوق مليان
// - تاريخ نسخ: آخر 5 نسخ لكل ملف في مجموعة filestore_history
// - الإقلاع يعالج كل الملفات المتتبعة حتى لو مجلد data فارغ (يصلح خطأ المسح السابق)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA = path.join(__dirname, '..', 'data');
const DBNAME = process.env.MONGO_DB || 'daralef';
const AUTO_MINUTES = Number(process.env.MONGO_AUTO_MIN || 9);
let client = null, col = null, histCol = null, ready = false;
const empties = {};
const timers = {};

const BACKUP_FILES = ['master.json', 'procurement.json', 'inventory.json', 'finance.json', 'sales.json', 'billing.json', 'production.json', 'employees.json', 'users.json', 'system.json'];

const OPERATIONAL = ['procurement.json', 'inventory.json', 'finance.json', 'sales.json', 'billing.json', 'production.json', 'employees.json'];
const AUTO_RESTORE_ON = !['0', 'false', 'no', 'off'].includes(String(process.env.MONGO_AUTO_RESTORE || '1').toLowerCase());

const Status = {
  lastPushAt: null,
  lastPullAt: null,
  lastAutoAt: null,
  lastAutoHealAt: null,
  lastAutoHealResult: null,
  autoRestore: AUTO_RESTORE_ON,
  cooldownUntil: null,
  lastError: null,
  pushed: 0,
  skippedEmpty: 0,
  healed: 0,
  autoHealed: 0,
  totalDocs: 0,
  startedAt: new Date().toISOString()
};
const HealLog = [];
function healLog(msg) {
  try {
    HealLog.unshift({ at: new Date().toISOString(), msg: String(msg).slice(0, 200) });
    if (HealLog.length > 20) HealLog.length = 20;
  } catch {}
}
function setCooldown(minutes) {
  try {
    const m = Math.max(1, Math.min(180, Number(minutes) || 30));
    Status.cooldownUntil = new Date(Date.now() + m * 60000).toISOString();
    healLog('تبريد الاسترجاع التلقائي ' + m + ' دقيقة (تصفير مقصود)');
  } catch {}
}
function inCooldown() {
  try {
    if (!Status.cooldownUntil) return false;
    return Date.now() < Date.parse(Status.cooldownUntil);
  } catch { return false; }
}
function parseLocal(b) {
  const content = readLocal(b);
  if (content === null) return { content: null, obj: null, rec: 0, meaningful: false, missing: true };
  let obj = null;
  try { obj = JSON.parse(content); } catch { return { content, obj: null, rec: 0, meaningful: false, missing: false }; }
  const rec = countRecords(obj);
  return { content, obj, rec, meaningful: isMeaningfulParsed(obj, content, b), missing: false };
}

function hashOf(s) { try { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); } catch { return ''; } }
function baseOf(f) { return path.basename(String(f || '')); }
function readLocal(f) { try { return fs.readFileSync(path.join(DATA, baseOf(f)), 'utf8'); } catch { return null; } }
function isFactory(f, content) {
  const e = empties[baseOf(f)];
  if (!e) return false;
  try { return hashOf(content || '') === hashOf(JSON.stringify(e)); } catch { return false; }
}
function countRecords(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let n = 0;
  for (const k of Object.keys(obj)) {
    if (k === '_meta' || k === 'seq') continue;
    const v = obj[k];
    if (Array.isArray(v)) n += v.length;
  }
  return n;
}
function isMeaningfulParsed(dataObj, contentStr, file) {
  if (!dataObj || typeof dataObj !== 'object') return false;
  if (isFactory(file, contentStr)) return false;
  const rec = countRecords(dataObj);
  if (rec <= 0) return false;
  // ملف حقيقي حجمه بالكيلو، المصنعي بضع مئات البايت — عتبة 2KB تمنع دفع الفراغ
  if (String(contentStr || '').length < 1500 && rec <= 4) return false;
  return true;
}
function note(file, empty) {
  try { empties[baseOf(file)] = JSON.parse(JSON.stringify(empty)); } catch {}
}
function queuePush(file) {
  if (!process.env.MONGODB_URI && !process.env.MONGO_URI) return;
  const b = baseOf(file);
  if (timers[b]) clearTimeout(timers[b]);
  timers[b] = setTimeout(() => pushOne(b).catch(e => { Status.lastError = String((e && e.message) || e).slice(0, 200); }), 2000);
}
async function saveHistory(b, dataObj, hash) {
  try {
    if (!histCol) return;
    const id = b + '__' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);
    await histCol.insertOne({ _id: id, file: b, data: dataObj, hash, at: new Date().toISOString() });
    const old = await histCol.find({ file: b }).sort({ at: -1 }).skip(5).toArray();
    for (const d of (old || [])) {
      try { await histCol.deleteOne({ _id: d._id }); } catch {}
    }
  } catch {}
}
async function pushOne(b) {
  if (!ready || !col) return { skipped: true, reason: 'not-ready' };
  const content = readLocal(b);
  if (content === null) return { skipped: true, reason: 'no-local' };
  let localObj = null;
  try { localObj = JSON.parse(content); } catch { return { skipped: true, reason: 'bad-local' }; }
  const localRec = countRecords(localObj);
  const localMeaning = isMeaningfulParsed(localObj, content, b);
  let cloudDoc = null;
  try { cloudDoc = await col.findOne({ _id: b }); } catch (e) { Status.lastError = String((e && e.message) || e).slice(0, 200); return { skipped: true, reason: 'cloud-read-fail' }; }
  if (cloudDoc && cloudDoc.data) {
    const cloudRec = countRecords(cloudDoc.data);
    const cloudMeaning = cloudRec > 0;
    // الحارس: سحابة مليانة + محلي مصنعي/فارغ = ممنوع الدفع، بل اشف المحلي بالسحب
    if (cloudMeaning && cloudRec > 5 && !localMeaning) {
      Status.skippedEmpty++;
      Status.lastError = null;
      try {
        fs.mkdirSync(DATA, { recursive: true });
        fs.writeFileSync(path.join(DATA, b), JSON.stringify(cloudDoc.data, null, 2), 'utf8');
        Status.healed++;
        Status.lastPullAt = new Date().toISOString();
      } catch {}
      return { skipped: true, reason: 'empty-guarded-healed', localRec, cloudRec };
    }
    // متساويان = لا داعي للدفع
    if ((cloudDoc.hash || '') === hashOf(content)) return { skipped: true, reason: 'same-hash' };
  } else {
    // لا وثيقة سحابية: لا تدفع الفراغ كأول بذرة
    if (!localMeaning) {
      Status.skippedEmpty++;
      return { skipped: true, reason: 'refuse-seed-empty' };
    }
  }
  try {
    await col.updateOne({ _id: b },
      { $set: { data: localObj, updatedAt: new Date().toISOString(), hash: hashOf(content), records: localRec } },
      { upsert: true });
    Status.lastPushAt = new Date().toISOString();
    Status.pushed++;
    try { Status.totalDocs = await col.countDocuments({ _id: { $ne: '__ping__' } }); } catch {}
    await saveHistory(b, localObj, hashOf(content));
    return { ok: true, records: localRec };
  } catch (e) {
    Status.lastError = String((e && e.message) || e).slice(0, 200);
    console.log('mongo push skip ' + b + ': ' + (e && e.message));
    return { skipped: true, reason: 'push-fail' };
  }
}
async function pushAllChanged() {
  if (!ready || !col) return { ok: false, reason: 'not-ready' };
  const out = {};
  for (const b of BACKUP_FILES) {
    try { out[b] = await pushOne(b); } catch (e) { out[b] = { skipped: true, reason: String((e && e.message) || e).slice(0, 100) }; }
  }
  Status.lastAutoAt = new Date().toISOString();
  return { ok: true, files: out, at: Status.lastAutoAt };
}
async function pullAtBoot() {
  // يعالج كل الملفات المتتبعة وليس فقط الموجودة محليا — يصلح خلل الإقلاع الفارغ
  for (const b of BACKUP_FILES) {
    try {
      const mdoc = await col.findOne({ _id: b });
      const local = readLocal(b);
      if (!mdoc || !mdoc.data) {
        if (local !== null) {
          let lo = null;
          try { lo = JSON.parse(local); } catch {}
          if (lo && isMeaningfulParsed(lo, local, b)) await pushOne(b); // بذر أول: فقط لو المحلي حقيقي
        }
        continue;
      }
      const cloudRec = countRecords(mdoc.data);
      if (local === null) {
        if (cloudRec > 0) {
          fs.mkdirSync(DATA, { recursive: true });
          fs.writeFileSync(path.join(DATA, b), JSON.stringify(mdoc.data, null, 2), 'utf8');
          console.log('mongo pull ' + b);
          Status.lastPullAt = new Date().toISOString();
        }
        continue;
      }
      let lo = null;
      try { lo = JSON.parse(local); } catch {}
      const localMeaning = lo ? isMeaningfulParsed(lo, local, b) : false;
      if (!localMeaning && cloudRec > 5) {
        fs.mkdirSync(DATA, { recursive: true });
        fs.writeFileSync(path.join(DATA, b), JSON.stringify(mdoc.data, null, 2), 'utf8');
        console.log('mongo heal ' + b);
        Status.healed++;
        Status.lastPullAt = new Date().toISOString();
      } else if (localMeaning && hashOf(local) !== (mdoc.hash || '')) {
        await pushOne(b); // المحلي أحدث وحقيقي ← ادفع
      }
    } catch (e) { console.log('mongo file skip ' + b + ': ' + (e && e.message)); }
  }
  try { Status.totalDocs = await col.countDocuments({ _id: { $ne: '__ping__' } }); } catch {}
}
function status() {
  return {
    ok: true,
    ready,
    db: DBNAME,
    autoMinutes: AUTO_MINUTES,
    autoRestore: Status.autoRestore,
    cooldownUntil: Status.cooldownUntil,
    lastPushAt: Status.lastPushAt,
    lastPullAt: Status.lastPullAt,
    lastAutoAt: Status.lastAutoAt,
    lastAutoHealAt: Status.lastAutoHealAt,
    lastAutoHealResult: Status.lastAutoHealResult,
    lastError: Status.lastError,
    pushed: Status.pushed,
    skippedEmpty: Status.skippedEmpty,
    healed: Status.healed,
    autoHealed: Status.autoHealed,
    totalDocs: Status.totalDocs,
    healLog: HealLog.slice(0, 5),
    startedAt: Status.startedAt,
    time: new Date().toISOString()
  };
}
async function preview() {
  if (!ready || !col) throw Object.assign(new Error('المزامنة غير مفعلة — تحقق من رابط مونغو'), { code: 400 });
  const docs = await col.find({ _id: { $ne: '__ping__' } }).toArray();
  const files = (docs || []).map(d => {
    const rec = d.data ? countRecords(d.data) : 0;
    return { file: d._id, updatedAt: d.updatedAt || null, hash: d.hash || null, records: rec };
  }).sort((a, b) => String(a.file) < String(b.file) ? -1 : 1);
  const totalRec = files.reduce((s, f) => s + (f.records || 0), 0);
  return { ok: true, db: DBNAME, count: files.length, totalRecords: totalRec, files, time: new Date().toISOString() };
}
async function safeRestore(ctx) {
  if (!ctx || ctx.role !== 'admin') throw Object.assign(new Error('الاستعادة للمدير العام فقط'), { code: 403 });
  if (!ready || !col) throw Object.assign(new Error('المزامنة غير مفعلة'), { code: 400 });
  const docs = await col.find({ _id: { $ne: '__ping__' } }).toArray();
  const files = (docs || []).filter(d => d && d.data);
  const totalRec = files.reduce((s, d) => s + countRecords(d.data), 0);
  // رفض نسخة فارغة: أقل من 5 ملفات أو سجلات شبه معدومة
  if (files.length < 5 || totalRec < 20) {
    throw Object.assign(new Error('النسخة السحابية فارغة أو ناقصة (' + files.length + ' ملفات، ' + totalRec + ' سجل) — رفضت الاستعادة لحماية بياناتك'), { code: 400 });
  }
  // أرشفة الوضع الحالي قبل الكتابة
  const ARCH = path.join(__dirname, '..', 'data-archive');
  const stamp = 'cloud-restore-' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.mkdirSync(path.join(ARCH, stamp), { recursive: true });
    for (const b of BACKUP_FILES) {
      try {
        const raw = fs.readFileSync(path.join(DATA, b), 'utf8');
        fs.writeFileSync(path.join(ARCH, stamp, b), raw, 'utf8');
      } catch {}
    }
  } catch {}
  const restored = [];
  for (const d of files) {
    const b = String(d._id || '');
    if (!BACKUP_FILES.includes(b)) continue;
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(path.join(DATA, b), JSON.stringify(d.data, null, 2), 'utf8');
      restored.push(b);
    } catch {}
  }
  Status.lastPullAt = new Date().toISOString();
  return { ok: true, restored, safety: stamp, count: files.length, totalRecords: totalRec };
}
// الحارس الدوري: يسترجع تلقائيا فقط عند مسح شامل غير مقصود
// الشرط الدقيق: الأساسية محليا فارغة + الأساسية سحابيا مليانة + العمليات سحابيا كاملة
// تصفير التجربة يحفظ الأساسية فلا يطلق الاسترجاع أبدا — التبريد حماية إضافية للاستعادات اليدوية
async function autoHealCheck(reason) {
  if (!ready || !col) return { ok: false, reason: 'not-ready' };
  if (!AUTO_RESTORE_ON) return { ok: false, reason: 'disabled' };
  if (inCooldown()) return { ok: false, reason: 'cooldown', until: Status.cooldownUntil };
  try {
    const lm = parseLocal('master.json');
    if (lm.meaningful) return { ok: false, reason: 'master-ok' };
    const docs = await col.find({ _id: { $ne: '__ping__' } }).toArray();
    const byId = {};
    for (const d of (docs || [])) if (d && d._id) byId[String(d._id)] = d;
    const cmDoc = byId['master.json'];
    const cmRec = cmDoc && cmDoc.data ? countRecords(cmDoc.data) : 0;
    if (!cmDoc || !cmDoc.data || cmRec < 5) return { ok: false, reason: 'cloud-master-empty' };
    let cloudOpFiles = 0, cloudOpRec = 0;
    for (const b of OPERATIONAL) {
      const d = byId[b];
      if (d && d.data) {
        const r = countRecords(d.data);
        if (r > 0) { cloudOpFiles++; cloudOpRec += r; }
      }
    }
    // بديل التاريخ: لو الواجهة فارغة لكن التاريخ فيه نسخ ذات معنى أعيد بناؤها
    let source = docs, sourceKind = 'live';
    if (cloudOpFiles < 5 || cloudOpRec < 20) {
      try {
        if (histCol) {
          const hist = await histCol.find({}).sort({ at: -1 }).limit(60).toArray();
          const best = {};
          for (const h of (hist || [])) {
            const f = String(h.file || '');
            if (!BACKUP_FILES.includes(f) || best[f]) continue;
            if (h.data && countRecords(h.data) > 0) best[f] = h;
          }
          const bf = Object.keys(best);
          const br = bf.reduce((s, f) => s + countRecords(best[f].data), 0);
          const bMaster = best['master.json'] ? countRecords(best['master.json'].data) : 0;
          if (bf.length >= 5 && br >= 20 && bMaster >= 5) {
            source = bf.map(f => ({ _id: f, data: best[f].data }));
            sourceKind = 'history';
            cloudOpFiles = 0; cloudOpRec = 0;
            for (const b of OPERATIONAL) {
              const h = best[b];
              if (h) { const r = countRecords(h.data); if (r > 0) { cloudOpFiles++; cloudOpRec += r; } }
            }
          }
        }
      } catch {}
      if (cloudOpFiles < 5 || cloudOpRec < 20) return { ok: false, reason: 'cloud-empty', files: cloudOpFiles, records: cloudOpRec };
    }
    // تحقق أخير: المحلي فعلا ممسوح شاملا (الأساسية + العمليات)
    let localOpRec = 0;
    for (const b of OPERATIONAL) localOpRec += parseLocal(b).rec;
    if (localOpRec >= 20) return { ok: false, reason: 'local-has-data' };
    // أرشفة الفراغ قبل الكتابة ثم السحب
    const ARCH = path.join(__dirname, '..', 'data-archive');
    const stamp = 'auto-heal-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try {
      fs.mkdirSync(path.join(ARCH, stamp), { recursive: true });
      for (const b of BACKUP_FILES) {
        try {
          const raw = fs.readFileSync(path.join(DATA, b), 'utf8');
          fs.writeFileSync(path.join(ARCH, stamp, b), raw, 'utf8');
        } catch {}
      }
    } catch {}
    const restored = [];
    for (const d of source) {
      const b = String((d && d._id) || '');
      if (!BACKUP_FILES.includes(b) || !d.data) continue;
      try {
        fs.mkdirSync(DATA, { recursive: true });
        fs.writeFileSync(path.join(DATA, b), JSON.stringify(d.data, null, 2), 'utf8');
        restored.push(b);
      } catch {}
    }
    Status.lastPullAt = new Date().toISOString();
    Status.lastAutoHealAt = Status.lastPullAt;
    Status.lastAutoHealResult = 'restored-' + sourceKind + ':' + restored.length;
    Status.healed++;
    Status.autoHealed++;
    healLog('شفاء تلقائي من ' + sourceKind + ' (' + restored.length + ' ملفات) — أرشيف ' + stamp);
    console.log('mongo auto-heal from ' + sourceKind + ' (' + restored.length + ' files)');
    return { ok: true, restored, safety: stamp, source: sourceKind };
  } catch (e) {
    Status.lastError = String((e && e.message) || e).slice(0, 200);
    return { ok: false, reason: 'error', error: Status.lastError };
  }
}
let autoTimer = null;
function startAuto() {
  try { if (autoTimer) clearInterval(autoTimer); } catch {}
  const ms = Math.max(3, Math.min(60, AUTO_MINUTES)) * 60 * 1000;
  autoTimer = setInterval(() => {
    // الترتيب: شفاء أولا (سحب عند المسح الشامل) ثم دفع التغييرات
    autoHealCheck('interval').catch(() => {}).finally(() => { pushAllChanged().catch(() => {}); });
  }, ms);
  try { if (autoTimer.unref) autoTimer.unref(); } catch {}
}
async function init() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.log('mongo sync off (no URI)'); return false; }
  const { MongoClient } = require('mongodb');
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
  await Promise.race([(async () => {
    client = new MongoClient(uri, { connectTimeoutMS: 8000, serverSelectionTimeoutMS: 8000 });
    await client.connect();
    col = client.db(DBNAME).collection('filestore');
    histCol = client.db(DBNAME).collection('filestore_history');
    await col.findOne({ _id: '__ping__' });
    ready = true;
  })(), timeout]);
  console.log('mongo sync on');
  await pullAtBoot();
  startAuto();
  // دفع أولي ذكي بعد الإقلاع بثواني (يلتقط ملفات أنشئت أثناء الإقلاع)
  setTimeout(() => { pushAllChanged().catch(() => {}); }, 15000);
  return true;
}

module.exports = { note, queuePush, init, preview, safeRestore, pushAllChanged, autoHealCheck, setCooldown, status, get ready() { return ready; } };

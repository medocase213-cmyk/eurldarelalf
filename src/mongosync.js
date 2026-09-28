// مرآة MongoDB لملفات البيانات — الملفات مرجع فوري، ومونغو نسخة باقية ضد مسح رندر
// القواعد: بلا URI يعمل كل شيء ملفات فقط. عند الإقلاع: يُسحب من مونغو فقط إن كان
// الملف المحلي مصنعياً (مطابقاً للقالب المسجل). كل حفظ ملفات يدفع نسخته بعد ثانيتين.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA = path.join(__dirname, '..', 'data');
const DBNAME = process.env.MONGO_DB || 'daralef';
let client = null, col = null, ready = false;
const empties = {};
const timers = {};

function hashOf(s) { try { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); } catch { return ''; } }
function baseOf(f) { return path.basename(String(f || '')); }
function readLocal(f) { try { return fs.readFileSync(path.join(DATA, baseOf(f)), 'utf8'); } catch { return null; } }
function isFactory(f, content) {
  const e = empties[baseOf(f)];
  if (!e) return false;
  try { return hashOf(content || '') === hashOf(JSON.stringify(e)); } catch { return false; }
}
function note(file, empty) {
  try { empties[baseOf(file)] = JSON.parse(JSON.stringify(empty)); } catch {}
}
function queuePush(file) {
  if (!process.env.MONGODB_URI && !process.env.MONGO_URI) return;
  const b = baseOf(file);
  if (timers[b]) clearTimeout(timers[b]);
  timers[b] = setTimeout(() => pushOne(b).catch(() => {}), 2000);
}
async function pushOne(b) {
  if (!ready || !col) return;
  const content = readLocal(b);
  if (content === null) return;
  try {
    await col.updateOne({ _id: b },
      { $set: { data: JSON.parse(content), updatedAt: new Date().toISOString(), hash: hashOf(content) } },
      { upsert: true });
  } catch (e) { console.log('mongo push skip ' + b + ': ' + (e && e.message)); }
}
async function pullAtBoot() {
  let files = [];
  try { files = fs.readdirSync(DATA).filter((f) => f.endsWith('.json')); } catch {}
  for (const b of files) {
    try {
      const mdoc = await col.findOne({ _id: b });
      const local = readLocal(b);
      if (!mdoc || !mdoc.data) {
        if (local !== null) await pushOne(b); // بذر أول: مونغو فارغة ← المحلي
        continue;
      }
      if (local === null || isFactory(b, local)) {
        fs.mkdirSync(DATA, { recursive: true });
        fs.writeFileSync(path.join(DATA, b), JSON.stringify(mdoc.data, null, 2), 'utf8');
        console.log('mongo pull ' + b);
      } else if (hashOf(local) !== (mdoc.hash || '')) {
        await pushOne(b); // المحلي أحدث ← ادفع
      }
    } catch (e) { console.log('mongo file skip ' + b + ': ' + (e && e.message)); }
  }
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
    await col.findOne({ _id: '__ping__' });
    ready = true;
  })(), timeout]);
  console.log('mongo sync on');
  await pullAtBoot();
  return true;
}

module.exports = { note, queuePush, init, get ready() { return ready; } };

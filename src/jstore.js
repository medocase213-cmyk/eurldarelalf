// مخزن JSON عام صغير — ملف مستقل لكل وحدة (مشتريات/مخزون/مالية)
// التزامن: كل الطفرات تُسلّسل بقفل الكتابة العام في server.js (lockWrite) — أي كود جديد
// يمس القرص خارج طلبات /api يجب أن يحترم نفس القاعدة (تسلسل كامل للمقطع load→save).
const fs = require('node:fs');
const path = require('node:path');
const Sync = require('./mongosync');

function jstore(file, empty) {
  const F = path.join(__dirname, '..', 'data', file);
  const clone = () => JSON.parse(JSON.stringify(empty));
  try { Sync.note(F, empty); } catch {}
  return {
    file: F,
    load() {
      try {
        fs.mkdirSync(path.dirname(F), { recursive: true });
        if (!fs.existsSync(F)) { fs.writeFileSync(F, JSON.stringify(empty, null, 2), 'utf8'); return clone(); }
        const d = JSON.parse(fs.readFileSync(F, 'utf8'));
        // نسخ عميق للافتراضيات: إسناد بالمرجع كان يلوث كائن empty المشترك عند أول حفظ جزئي
        for (const k of Object.keys(empty)) if (d[k] === undefined) d[k] = JSON.parse(JSON.stringify(empty[k]));
        return d;
      } catch { return clone(); }
    },
    save(d) {
      fs.mkdirSync(path.dirname(F), { recursive: true });
      const tmp = F + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
      fs.renameSync(tmp, F);
      try { Sync.queuePush(F); } catch {}
    }
  };
}

module.exports = jstore;

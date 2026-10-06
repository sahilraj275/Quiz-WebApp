// Copy an old data.json into the current store (Upstash Redis if its env vars are set, else quiz-data.json).
// Usage: node migrate.js [path/to/data.json]   Safe to run twice: it overwrites the same records.
const fs = require('fs');
const crypto = require('crypto');
const db = require('./store');

const file = process.argv[2] || 'data.json';
const old = JSON.parse(fs.readFileSync(file, 'utf8'));
const newId = (len) => crypto.randomBytes(len).toString('hex').slice(0, len);

(async () => {
  for (const q of Object.values(old.quizzes || {})) await db.hset('qr:quizzes', q.id, q);
  const attempts = Object.values(old.attempts || {}).sort((a, b) => a.submittedAt - b.submittedAt);
  for (const a of attempts) {
    const { reactions = {}, ...rest } = a;
    rest.rid = rest.rid || newId(10);
    await db.hset(`qr:att:${a.quizId}`, a.id, rest);
    await db.hset('qr:aidx', a.id, { q: a.quizId });
    await db.hset('qr:ridx', rest.rid, { q: a.quizId, a: a.id });
    if (!a.practice) await db.hsetnx(`qr:names:${a.quizId}`, a.name.toLowerCase(), { a: a.id });
    for (const [emoji, devs] of Object.entries(reactions)) for (const d of devs) await db.hset(`qr:react:${a.quizId}`, `${rest.rid}|${emoji}|${d}`, 1);
  }
  console.log(`Copied ${Object.keys(old.quizzes || {}).length} quizzes and ${attempts.length} attempts into ${db.kind}.`);
})().catch((e) => { console.error(e); process.exit(1); });

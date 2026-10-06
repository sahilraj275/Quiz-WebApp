// Storage: Upstash Redis when its env vars are set (Vercel), otherwise a local JSON file.
// Only the handful of Redis commands the server needs, with the same behaviour in both.
const fs = require('fs');
const path = require('path');

function redisStore(url, token) {
  const { Redis } = require('@upstash/redis');
  const r = new Redis({ url, token }); // objects are JSON-encoded/decoded automatically
  return {
    hget: (k, f) => r.hget(k, f),
    hset: (k, f, v) => r.hset(k, { [f]: v }),
    hsetnx: (k, f, v) => r.hsetnx(k, f, v),
    hdel: (k, ...f) => (f.length ? r.hdel(k, ...f) : 0),
    hgetall: async (k) => (await r.hgetall(k)) || {},
    hlen: (k) => r.hlen(k),
    del: (...k) => r.del(...k),
    get: (k) => r.get(k),
    set: (k, v, ex) => r.set(k, v, { ex }),
    incr: async (k, ex) => { const n = await r.incr(k); if (n === 1) await r.expire(k, ex); return n; },
  };
}

function fileStore(file) {
  let d = { h: {}, s: {} };
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(d)); fs.renameSync(file + '.tmp', file); };
  const h = (k) => d.h[k] || (d.h[k] = {});
  const copy = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const live = (k) => { const e = d.s[k]; if (e && e.exp < Date.now()) { delete d.s[k]; return null; } return e || null; };
  return {
    async hget(k, f) { return copy(h(k)[f]); },
    async hset(k, f, v) { h(k)[f] = copy(v); save(); },
    async hsetnx(k, f, v) { if (f in h(k)) return 0; h(k)[f] = copy(v); save(); return 1; },
    async hdel(k, ...f) { let n = 0; for (const x of f) if (x in h(k)) { delete h(k)[x]; n++; } save(); return n; },
    async hgetall(k) { return copy(h(k)); },
    async hlen(k) { return Object.keys(h(k)).length; },
    async del(...k) { for (const x of k) { delete d.h[x]; delete d.s[x]; } save(); },
    async get(k) { const e = live(k); return e ? copy(e.v) : null; },
    async set(k, v, ex) { d.s[k] = { v: copy(v), exp: Date.now() + ex * 1000 }; save(); },
    async incr(k, ex) { const e = live(k) || (d.s[k] = { v: 0, exp: Date.now() + ex * 1000 }); e.v++; save(); return e.v; },
  };
}

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
module.exports = url && token
  ? redisStore(url, token)
  : fileStore(process.env.DATA_FILE || path.join(__dirname, 'quiz-data.json'));
module.exports.kind = url && token ? 'Upstash Redis' : 'local file';

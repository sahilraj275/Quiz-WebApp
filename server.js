// Quiz Room — no-login office quiz server
// Local: npm install && npm start   (optional: ADMIN_PIN=4321 PORT=4000 npm start)
// Vercel: api/index.js exports this app; data goes to Upstash Redis (see README)

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const db = require('./store');

const PORT = process.env.PORT || 4000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const GRACE = 60; // seconds allowed past the time limit for slow phones / networks
const SESSION_TTL = 24 * 3600; // an unfinished quiz can be resumed for a day

// ---------- keys ----------
// quizzes            hash  quizId -> quiz
// att:<quizId>       hash  attemptId -> attempt
// aidx / ridx        hash  attemptId -> { q }, reactionId -> { q, a }
// names:<quizId>     hash  lowercased name -> { a } (ranked attempts only; hsetnx makes "one per name" atomic)
// Index values are objects, not bare id strings: Upstash JSON-parses values, so "12e45678" would come back as a number.
// react:<quizId>     hash  "rid|emoji|device" -> 1
// sess:<sid>         value session, expires after SESSION_TTL
// pin:<ip>           counter of wrong admin PINs, expires after 15 min
const K = {
  quizzes: 'qr:quizzes', att: (q) => `qr:att:${q}`, aidx: 'qr:aidx', ridx: 'qr:ridx',
  names: (q) => `qr:names:${q}`, react: (q) => `qr:react:${q}`, sess: (s) => `qr:sess:${s}`, pin: (ip) => `qr:pin:${ip}`,
};

const newId = (len) => crypto.randomBytes(len).toString('hex').slice(0, len);
const AVATARS = ['🦊', '🐼', '🤖', '👾', '🐱', '🦄', '🐸', '🐧', '🦁', '🐙', '🚀', '🧙'];
const REACTIONS = ['👏', '🔥', '😂', '🤯'];

// ---------- helpers ----------
// Spaces and line breaks count the same, so "3 2 1" matches "3\n2\n1".
const norm = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).join(' ');
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
const attemptsOf = async (quizId) => Object.values(await db.hgetall(K.att(quizId)));
const getQuiz = (id) => db.hget(K.quizzes, String(id));
const rankSort = (a, b) => (a.late ? 1 : 0) - (b.late ? 1 : 0) || b.score - a.score
  || a.timeTaken - b.timeTaken || a.submittedAt - b.submittedAt;
const publicQuestions = (q) => q.questions.map(({ type, text, code, language, options, tag }) => ({ type, text, code, language, options, tag }));

function cleanQuiz(body) {
  const title = String(body.title || '').trim();
  if (!title) throw 'Add a quiz title.';
  const list = Array.isArray(body.questions) ? body.questions : [];
  if (!list.length) throw 'Add at least one question.';
  const questions = list.map((q, i) => {
    const n = i + 1;
    const type = q.type === 'output' ? 'output' : 'mcq';
    const text = String(q.text || '').trim();
    if (!text) throw `Question ${n} has no question text.`;
    const out = {
      type, text,
      code: String(q.code || '').replace(/\s+$/, ''),
      language: String(q.language || 'javascript'),
      explanation: String(q.explanation || '').trim(),
      tag: String(q.tag || '').trim().slice(0, 40),
    };
    if (type === 'mcq') {
      const options = (Array.isArray(q.options) ? q.options : []).map((o) => String(o).trim());
      if (options.length < 2) throw `Question ${n} needs at least 2 options.`;
      if (options.some((o) => !o)) throw `Question ${n} has an empty option. Fill it in or remove it.`;
      const answer = Number(q.answer);
      if (!Number.isInteger(answer) || answer < 0 || answer >= options.length)
        throw `Pick the correct option for question ${n}.`;
      out.options = options; out.answer = answer;
    } else {
      const answer = String(q.answer ?? '').trim();
      if (!answer) throw `Question ${n} needs the expected output.`;
      out.answer = answer;
    }
    return out;
  });
  return {
    title,
    topic: String(body.topic || '').trim(),
    timeLimit: Math.max(0, Math.round(Number(body.timeLimit) || 0)),
    showAnswers: body.showAnswers !== false,
    shuffle: body.shuffle !== false,
    practice: !!body.practice,
    code: String(body.code || '').trim().slice(0, 40),
    questions,
  };
}

const app = express();
if (process.env.VERCEL) app.set('trust proxy', true); // real client IP for the PIN lockout
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Express 4 doesn't catch rejected promises; route them to the error handler at the bottom.
const h = (fn) => (req, res, next) => fn(req, res).catch(next);

const isAdmin = (req) => req.get('x-admin-pin') === ADMIN_PIN;
const admin = (req, res, next) => (async () => {
  const key = K.pin(req.ip);
  if (Number(await db.get(key)) >= 10) return res.status(429).json({ error: 'Too many wrong PINs. Try again in 15 minutes.' });
  if (isAdmin(req)) return next();
  await db.incr(key, 15 * 60);
  res.status(401).json({ error: 'That PIN is wrong.' });
})().catch(next);

// ---------- public ----------
app.get('/api/info', (req, res) => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && (n.family === 'IPv4' || n.family === 4) && !n.internal)
    .map((n) => `http://${n.address}:${PORT}`);
  res.json({ lanUrls: ips });
});

app.get('/api/quizzes', h(async (req, res) => {
  res.json(Object.values(await db.hgetall(K.quizzes)).filter((q) => !q.closed)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((q) => ({ id: q.id, title: q.title, topic: q.topic, count: q.questions.length, timeLimit: q.timeLimit,
      practice: !!q.practice, locked: !!q.code })));
}));

// Quiz details without the questions: those are only handed out once a session starts (after the access code).
app.get('/api/quizzes/:id', h(async (req, res) => {
  const q = await getQuiz(req.params.id);
  if (!q) return res.status(404).json({ error: 'This quiz link is not valid. Ask for a fresh link.' });
  res.json({
    id: q.id, title: q.title, topic: q.topic, timeLimit: q.timeLimit, closed: !!q.closed,
    count: q.questions.length, practice: !!q.practice, locked: !!q.code,
  });
}));

app.post('/api/quizzes/:id/start', h(async (req, res) => {
  const q = await getQuiz(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quiz not found.' });
  if (q.closed) return res.status(403).json({ error: 'This quiz is closed.' });
  if (q.code && String(req.body.code || '').trim().toLowerCase() !== q.code.toLowerCase())
    return res.status(403).json({ error: 'That access code is wrong. Ask the quiz creator for it.' });
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Type your name to start.' });
  if (!q.practice && await db.hget(K.names(q.id), name.toLowerCase()))
    return res.status(409).json({ error: `"${name}" has already taken this quiz. Use a different name.` });
  const avatar = AVATARS.includes(req.body.avatar) ? req.body.avatar : '';
  const s = { id: newId(16), quizId: q.id, name, avatar, startedAt: Date.now(), practice: !!q.practice };
  await db.set(K.sess(s.id), s, SESSION_TTL);
  res.json({ sid: s.id });
}));

app.get('/api/sessions/:sid', h(async (req, res) => {
  const s = await db.get(K.sess(req.params.sid));
  const q = s && await getQuiz(s.quizId);
  if (!q) return res.status(404).json({ error: 'This quiz session has expired. Open the quiz link again to restart.' });
  res.json({
    sid: s.id, name: s.name, startedAt: s.startedAt, now: Date.now(), practice: s.practice,
    quiz: { id: q.id, title: q.title, topic: q.topic, timeLimit: q.timeLimit, shuffle: q.shuffle !== false, questions: publicQuestions(q) },
  });
}));

app.post('/api/sessions/:sid/submit', h(async (req, res) => {
  const s = await db.get(K.sess(req.params.sid));
  const quiz = s && await getQuiz(s.quizId);
  if (!quiz) return res.status(404).json({ error: 'This quiz session has expired. Open the quiz link again to restart.' });
  if (quiz.closed) return res.status(403).json({ error: 'This quiz is closed, so answers are no longer accepted.' });
  const name = cleanName(req.body.name) || s.name;
  const elapsed = (Date.now() - s.startedAt) / 1000;
  const id = newId(12);
  // Claim the name atomically, so two people submitting as "Ravi" at the same moment can't both get in.
  if (!s.practice && !await db.hsetnx(K.names(quiz.id), name.toLowerCase(), { a: id }))
    return res.status(409).json({ error: `"${name}" has already taken this quiz.` });

  const given = Array.isArray(req.body.answers) ? req.body.answers : [];
  const items = quiz.questions.map((q, i) => {
    let g = given[i]; let correct;
    if (q.type === 'mcq') {
      g = g === null || g === undefined || g === '' ? null : Number(g);
      if (!Number.isInteger(g)) g = null;
      correct = g === q.answer;
    } else {
      g = g == null ? '' : String(g).slice(0, 5000);
      correct = !!norm(g) && norm(g) === norm(q.answer);
    }
    return { ...q, given: g, correct };
  });

  const attempt = {
    id, quizId: quiz.id, quizTitle: quiz.title, topic: quiz.topic, name,
    score: items.filter((x) => x.correct).length, total: items.length,
    timeTaken: Math.round(elapsed),
    late: !!quiz.timeLimit && elapsed > quiz.timeLimit * 60 + GRACE,
    practice: s.practice, avatar: s.avatar || '', rid: newId(10),
    submittedAt: Date.now(), items,
  };
  await db.hset(K.att(quiz.id), id, attempt);
  await db.hset(K.aidx, id, { q: quiz.id });
  await db.hset(K.ridx, attempt.rid, { q: quiz.id, a: id });
  await db.del(K.sess(s.id));
  res.json({ id });
}));

app.get('/api/attempts/:aid', h(async (req, res) => {
  const ix = await db.hget(K.aidx, String(req.params.aid));
  const a = ix && await db.hget(K.att(ix.q), String(req.params.aid));
  if (!a) return res.status(404).json({ error: 'This answer sheet was not found.' });
  const quiz = await getQuiz(a.quizId);
  const hide = quiz && quiz.showAnswers === false && !isAdmin(req);
  const timeLimit = quiz ? quiz.timeLimit : 0;
  res.json(hide ? { ...a, items: null, timeLimit } : { ...a, timeLimit });
}));

app.get('/api/quizzes/:id/leaderboard', h(async (req, res) => {
  const q = await getQuiz(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quiz not found.' });
  const mine = new Set(String(req.query.mine || '').split(',').filter(Boolean));
  const dev = String(req.query.dev || '');
  const [attempts, reacts] = await Promise.all([attemptsOf(q.id), db.hgetall(K.react(q.id))]);
  const count = {}; // "rid|emoji" -> n
  for (const f of Object.keys(reacts)) { const k = f.slice(0, f.lastIndexOf('|')); count[k] = (count[k] || 0) + 1; }
  res.json({
    title: q.title, topic: q.topic, total: q.questions.length, practice: !!q.practice,
    entries: attempts.filter((a) => !a.practice).sort(rankSort).map((a) => ({
      name: a.name, score: a.score, total: a.total, timeTaken: a.timeTaken, late: !!a.late,
      submittedAt: a.submittedAt, you: mine.has(a.id), avatar: a.avatar || '', rid: a.rid,
      reactions: REACTIONS.map((e) => ({ e, n: count[`${a.rid}|${e}`] || 0, me: `${a.rid}|${e}|${dev}` in reacts })),
    })),
  });
}));

// Toggle one emoji reaction on a leaderboard entry.
// ponytail: dev is a random id from the browser, so a determined person can fake extra reactions; fine for office fun
app.post('/api/reactions', h(async (req, res) => {
  const { rid, emoji, dev } = req.body;
  if (!REACTIONS.includes(emoji) || !/^[a-f0-9]{16}$/.test(String(dev))) return res.status(400).json({ error: 'Bad reaction.' });
  const ref = await db.hget(K.ridx, String(rid));
  if (!ref) return res.status(404).json({ error: 'Entry not found.' });
  const key = K.react(ref.q), field = `${rid}|${emoji}|${dev}`;
  const removed = await db.hdel(key, field);
  if (!removed) await db.hset(key, field, 1);
  const n = Object.keys(await db.hgetall(key)).filter((f) => f.startsWith(`${rid}|${emoji}|`)).length;
  res.json({ n, me: !removed });
}));

// ---------- admin (PIN only, no accounts) ----------
app.post('/api/admin/check', admin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/quizzes', admin, h(async (req, res) => {
  const quizzes = Object.values(await db.hgetall(K.quizzes)).sort((a, b) => b.createdAt - a.createdAt);
  const counts = await Promise.all(quizzes.map((q) => db.hlen(K.att(q.id))));
  res.json(quizzes.map((q, i) => ({
    id: q.id, title: q.title, topic: q.topic, count: q.questions.length,
    attempts: counts[i], closed: !!q.closed, createdAt: q.createdAt,
    practice: !!q.practice, locked: !!q.code,
  })));
}));

app.get('/api/admin/quizzes/:id', admin, h(async (req, res) => {
  const q = await getQuiz(req.params.id);
  q ? res.json(q) : res.status(404).json({ error: 'Quiz not found.' });
}));

app.post('/api/admin/quizzes', admin, h(async (req, res) => {
  let quiz;
  try { quiz = { id: newId(8), createdAt: Date.now(), closed: false, ...cleanQuiz(req.body) }; }
  catch (e) { return res.status(400).json({ error: String(e) }); }
  await db.hset(K.quizzes, quiz.id, quiz);
  res.json({ id: quiz.id });
}));

app.put('/api/admin/quizzes/:id', admin, h(async (req, res) => {
  const old = await getQuiz(req.params.id);
  if (!old) return res.status(404).json({ error: 'Quiz not found.' });
  let quiz;
  try { quiz = { ...old, ...cleanQuiz(req.body) }; } catch (e) { return res.status(400).json({ error: String(e) }); }
  await db.hset(K.quizzes, old.id, quiz);
  res.json({ id: old.id });
}));

app.post('/api/admin/quizzes/:id/toggle', admin, h(async (req, res) => {
  const q = await getQuiz(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quiz not found.' });
  q.closed = !q.closed;
  await db.hset(K.quizzes, q.id, q);
  res.json({ closed: q.closed });
}));

app.delete('/api/admin/quizzes/:id', admin, h(async (req, res) => {
  const id = String(req.params.id);
  const attempts = await attemptsOf(id);
  await db.hdel(K.aidx, ...attempts.map((a) => a.id));
  await db.hdel(K.ridx, ...attempts.map((a) => a.rid));
  await db.del(K.att(id), K.names(id), K.react(id));
  await db.hdel(K.quizzes, id);
  res.json({ ok: true }); // unfinished sessions just expire on their own
}));

app.get('/api/admin/quizzes/:id/attempts', admin, h(async (req, res) => {
  res.json((await attemptsOf(req.params.id)).sort(rankSort));
}));

app.delete('/api/admin/attempts/:aid', admin, h(async (req, res) => {
  const aid = String(req.params.aid);
  const ix = await db.hget(K.aidx, aid);
  const quizId = ix && ix.q;
  const a = quizId && await db.hget(K.att(quizId), aid);
  if (a) {
    const lower = a.name.toLowerCase();
    if ((await db.hget(K.names(quizId), lower) || {}).a === aid) await db.hdel(K.names(quizId), lower); // frees the name
    const reacts = Object.keys(await db.hgetall(K.react(quizId))).filter((f) => f.startsWith(a.rid + '|'));
    await db.hdel(K.react(quizId), ...reacts);
    await db.hdel(K.ridx, a.rid);
    await db.hdel(K.att(quizId), aid);
  }
  await db.hdel(K.aidx, aid);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'The server hit a problem. Try again in a moment.' });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter((n) => n && (n.family === 'IPv4' || n.family === 4) && !n.internal).map((n) => n.address);
    console.log('\nQuiz Room is running');
    console.log(`  On this computer:  http://localhost:${PORT}`);
    ips.forEach((ip) => console.log(`  On office Wi-Fi:   http://${ip}:${PORT}`));
    console.log(`  Data:              ${db.kind}`);
    console.log(`  Admin PIN:         ${ADMIN_PIN === '1234' ? '1234  (change it: ADMIN_PIN=yourpin npm start)' : 'set from ADMIN_PIN'}\n`);
    if (ADMIN_PIN === '1234') console.warn('  WARNING: you are using the default admin PIN. Anyone on the network can guess it.\n');
  });
}

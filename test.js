// Self-check: node test.js  (starts the server on a temp data file, runs the main flows, exits non-zero on failure)
const { spawn, spawnSync } = require('child_process');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = 4917, PIN = 'test-pin';
const DATA_FILE = path.join(os.tmpdir(), `quiz-room-test-${Date.now()}.json`);
const base = `http://127.0.0.1:${PORT}`;

async function call(method, url, body, admin) {
  const headers = { 'Content-Type': 'application/json' };
  if (admin) headers['x-admin-pin'] = admin === true ? PIN : admin;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const quiz = {
    title: 'T', code: 'Open', timeLimit: 0,
    questions: [
      { type: 'mcq', text: 'a', options: ['x', 'y'], answer: 1, tag: 'Closures' },
      { type: 'output', text: 'b', answer: '3\n2\n1', tag: 'Event loop' },
    ],
  };
  const { body: { id } } = await call('POST', '/api/admin/quizzes', quiz, true);
  assert.ok(id, 'quiz created');

  // questions are not public before starting
  const meta = await call('GET', `/api/quizzes/${id}`);
  assert.strictEqual(meta.body.questions, undefined);
  assert.strictEqual(meta.body.locked, true);

  // access code is required (case-insensitive)
  assert.strictEqual((await call('POST', `/api/quizzes/${id}/start`, { name: 'Sahil', code: 'nope' })).status, 403);
  const { body: { sid } } = await call('POST', `/api/quizzes/${id}/start`, { name: 'Sahil', code: 'open', avatar: '🦊' });
  const sess = await call('GET', `/api/sessions/${sid}`);
  assert.strictEqual(sess.body.quiz.questions[0].answer, undefined, 'answers stay hidden');

  // server measures time; "3 2 1" on one line matches "3\n2\n1"
  const sub = await call('POST', `/api/sessions/${sid}/submit`, { answers: [1, '3 2 1'], timeTaken: 0.001 });
  const att = (await call('GET', `/api/attempts/${sub.body.id}`)).body;
  assert.strictEqual(att.score, 2);
  assert.ok(att.timeTaken >= 0 && att.late === false);
  assert.strictEqual((await call('POST', `/api/sessions/${sid}/submit`, { answers: [] })).status, 404, 'session is single-use');

  // name is taken for ranked quizzes...
  assert.strictEqual((await call('POST', `/api/quizzes/${id}/start`, { name: 'sahil', code: 'open' })).status, 409);
  // ...two sessions racing on one name: only the first submit wins
  const r1 = (await call('POST', `/api/quizzes/${id}/start`, { name: 'Ravi', code: 'open' })).body.sid;
  const r2 = (await call('POST', `/api/quizzes/${id}/start`, { name: 'ravi', code: 'open' })).body.sid;
  const [s1, s2] = await Promise.all([r1, r2].map((x) => call('POST', `/api/sessions/${x}/submit`, { answers: [] })));
  assert.deepStrictEqual([s1.status, s2.status].sort(), [200, 409]);
  // removing an attempt frees the name again
  await call('DELETE', `/api/admin/attempts/${(s1.status === 200 ? s1 : s2).body.id}`, null, true);
  assert.strictEqual((await call('POST', `/api/quizzes/${id}/start`, { name: 'Ravi', code: 'open' })).status, 200);
  // ...but practice mode allows retakes and keeps them off the leaderboard
  await call('PUT', `/api/admin/quizzes/${id}`, { ...quiz, practice: true }, true);
  const p = await call('POST', `/api/quizzes/${id}/start`, { name: 'Sahil', code: 'open' });
  assert.strictEqual(p.status, 200);
  await call('POST', `/api/sessions/${p.body.sid}/submit`, { answers: [0, ''] });
  const lb = (await call('GET', `/api/quizzes/${id}/leaderboard`)).body;
  assert.strictEqual(lb.entries.length, 1);
  assert.strictEqual(lb.entries[0].avatar, '🦊');
  assert.strictEqual(lb.entries[0].id, undefined, 'attempt id (opens the answer sheet) is not leaked');

  // reactions toggle per device
  const react = (dev) => call('POST', '/api/reactions', { rid: lb.entries[0].rid, emoji: '🔥', dev });
  assert.strictEqual((await react('a'.repeat(16))).body.n, 1);
  assert.strictEqual((await react('b'.repeat(16))).body.n, 2);
  assert.strictEqual((await react('a'.repeat(16))).body.n, 1, 'second tap removes it');
  assert.strictEqual((await call('POST', '/api/reactions', { rid: lb.entries[0].rid, emoji: '💩', dev: 'a'.repeat(16) })).status, 400);

  // overall leaderboard: sums a name across quizzes (case-insensitive), skips practice attempts
  const { body: { id: id2 } } = await call('POST', '/api/admin/quizzes', { ...quiz, code: '' }, true);
  const s3 = (await call('POST', `/api/quizzes/${id2}/start`, { name: 'SAHIL' })).body.sid;
  await call('POST', `/api/sessions/${s3}/submit`, { answers: [1, 'nope'] });
  const all = (await call('GET', '/api/leaderboard')).body;
  assert.strictEqual(all.entries.length, 1);
  assert.deepStrictEqual([all.entries[0].score, all.entries[0].total, all.entries[0].quizzes], [3, 4, 2]);

  // admin merges "Ravi" into "Sahil": totals, wins, streak and topic champion follow
  const s4 = (await call('POST', `/api/quizzes/${id2}/start`, { name: 'Ravi' })).body.sid;
  await call('POST', `/api/sessions/${s4}/submit`, { answers: [1, '3 2 1'] });
  assert.strictEqual((await call('GET', '/api/leaderboard')).body.entries.length, 2);
  assert.strictEqual((await call('POST', '/api/admin/aliases', { from: 'ravi', to: 'Sahil' }, true)).status, 200);
  assert.strictEqual((await call('POST', '/api/admin/aliases', { from: 'Sahil', to: 'SAHIL' }, true)).status, 400, 'same name');
  const merged = (await call('GET', '/api/leaderboard')).body;
  assert.strictEqual(merged.entries.length, 1);
  const me = merged.entries[0];
  // Ravi's attempt was a retake of quiz 2 by the same person: only the first attempt (SAHIL, 1/2) counts
  assert.deepStrictEqual([me.name, me.score, me.total, me.quizzes, me.wins, me.streak], ['Sahil', 3, 4, 2, 2, 2]);
  assert.strictEqual(me.history.length, 2);
  assert.strictEqual(merged.topics.find((t) => t.tag === 'Closures'), undefined, '2 answered is below the 3 needed');
  await call('DELETE', '/api/admin/aliases/ravi', null, true);
  assert.strictEqual((await call('GET', '/api/leaderboard')).body.entries.length, 2, 'undo splits them again');

  // insights: every question across quizzes, hardest first
  const ins = (await call('GET', '/api/admin/insights', null, true)).body;
  assert.strictEqual(ins.questions.length, 4);
  assert.strictEqual(ins.noExplain.length, 4, 'test questions have no explanations');
  for (let i = 1; i < 4; i++) assert.ok(ins.questions[i - 1].ok / ins.questions[i - 1].n <= ins.questions[i].ok / ins.questions[i].n);

  // mistakes by name: only once the quiz is closed, never from open quizzes
  assert.strictEqual((await call('GET', '/api/mistakes?name=sahil')).body.length, 0, 'open quizzes stay hidden');
  await call('POST', `/api/admin/quizzes/${id2}/toggle`, null, true);
  const mis = (await call('GET', '/api/mistakes?name=sahil')).body;
  assert.strictEqual(mis.length, 1);
  assert.strictEqual(mis[0].id, undefined, 'attempt id is not leaked');
  assert.strictEqual(mis[0].items.filter((x) => !x.correct).length, 1);

  // revision quiz: hardest questions carry the full question (with answer) but not anyone's given answer
  const hq = (await call('GET', '/api/admin/insights', null, true)).body.questions[0].question;
  assert.ok(hq.text && hq.answer !== undefined && hq.given === undefined && hq.correct === undefined);

  // backup: export everything, restore into an empty store with migrate.js, nothing lost
  const backup = (await call('GET', '/api/admin/export', null, true)).body;
  assert.strictEqual(Object.keys(backup.quizzes).length, 2);
  assert.ok(Object.values(backup.attempts).some((a) => (a.reactions['🔥'] || []).length === 1), 'reactions kept');
  const bFile = DATA_FILE + '.backup.json', rFile = DATA_FILE + '.restored.json';
  await call('POST', '/api/admin/aliases', { from: 'ravi', to: 'Sahil' }, true);
  fs.writeFileSync(bFile, JSON.stringify((await call('GET', '/api/admin/export', null, true)).body));
  spawnSync(process.execPath, [path.join(__dirname, 'migrate.js'), bFile], { env: { ...process.env, DATA_FILE: rFile } });
  const restored = JSON.parse(fs.readFileSync(rFile, 'utf8')).h;
  assert.strictEqual(Object.keys(restored['qr:quizzes']).length, 2);
  assert.strictEqual(Object.keys(restored['qr:aidx']).length, Object.keys(backup.attempts).length);
  assert.strictEqual(restored['qr:alias'].ravi.to, 'Sahil');
  fs.rmSync(bFile); fs.rmSync(rFile);

  // wrong PINs lock out after 10 tries
  for (let i = 0; i < 10; i++) await call('GET', '/api/admin/quizzes', null, 'wrong');
  assert.strictEqual((await call('GET', '/api/admin/quizzes', null, true)).status, 429);

  console.log('All checks passed');
}

const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT, ADMIN_PIN: PIN, DATA_FILE }, stdio: ['ignore', 'pipe', 'inherit'],
});
srv.stdout.once('data', () => main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { srv.kill(); fs.rmSync(DATA_FILE, { force: true }); }));

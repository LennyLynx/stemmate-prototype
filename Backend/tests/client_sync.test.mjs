// Client-to-backend integration tests. Run: node --test tests/
// Each test starts a real backend (Python) on a random port with a throw-away database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { Client, validatePlan } = require(path.join(here, '..', 'static', 'stemmate-client.js'));

class FakeStorage {
  constructor(limit) { this.m = new Map(); this.limit = limit; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (this.limit && v.length > this.limit) throw new Error('QuotaExceeded'); this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', [path.join(here, 'serve_for_tests.py')], { stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.once('data', (d) => resolve({ base: 'http://127.0.0.1:' + String(d).trim().split(' ')[1], stop: () => p.kill() }));
    p.once('error', reject);
  });
}

async function withServer(fn) {
  const srv = await startServer();
  try { await fn(srv.base); } finally { srv.stop(); }
}

const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const plan = (over = {}) => ({ title: 'Fractions with bottle caps', subject: 'Mathematics', lessonDate: today(), durationMin: 45,
  learnerCount: 22, steps: 'Sort caps', materials: 'Caps, paper', safety: 'No small items in mouths', inclusion: 'Pair learners', notes: '', ...over });

async function signedIn(base, fid = 'FAC-01', pin = '4821', storage = new FakeStorage()) {
  const c = new Client({ baseUrl: base, storage });
  const r = await c.login(fid, pin);
  assert.equal(r.ok, true);
  return c;
}
const serverLessons = async (c) => (await c.request('GET', '/api/lessons')).data.lessons;

test('C01 offline save is kept on the device, shown as waiting, and survives a restart', () => withServer(async (base) => {
  const storage = new FakeStorage();
  const c = await signedIn(base, 'FAC-01', '4821', storage);
  c.simulateOffline = true;
  const saved = c.savePlan(plan());
  assert.equal(saved.ok, true);
  assert.equal(saved.plan.status, 'waiting');
  assert.deepEqual(await c.syncNow(), { offline: true });
  assert.equal(c.plans()[0].status, 'waiting');
  c.simulateOffline = false;
  assert.equal((await serverLessons(c)).length, 0);              // nothing reached the server
  const reopened = await signedIn(base, 'FAC-01', '4821', storage);   // new session, same device storage
  assert.equal(reopened.plans().length, 1);
  assert.equal(reopened.plans()[0].data.materials, 'Caps, paper'); // all six plan fields kept
  assert.equal(reopened.state.queue.length, 1);
}));

test('C02 reconnecting syncs the queue and the server holds the same lesson', () => withServer(async (base) => {
  const c = await signedIn(base);
  c.savePlan(plan());
  const r = await c.syncNow();
  assert.equal(r.synced, 1);
  assert.equal(c.plans()[0].status, 'synced');
  assert.equal(c.state.queue.length, 0);
  const lessons = await serverLessons(c);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].safety, 'No small items in mouths');
}));

test('C03 a response lost after the server saved it never creates a duplicate', () => withServer(async (base) => {
  const c = await signedIn(base);
  c.savePlan(plan());
  const realFetch = c.fetchFn;
  let dropped = false;
  c.fetchFn = async (url, init) => {
    const res = await realFetch(url, init);                      // the server processes the request ...
    if (url.endsWith('/api/sync') && !dropped) { dropped = true; throw new TypeError('connection lost'); }   // ... but the reply is lost
    return res;
  };
  assert.deepEqual(await c.syncNow(), { offline: true });
  assert.equal(c.plans()[0].status, 'waiting');                  // client cannot know; keeps the operation
  assert.equal(c.state.queue.length, 1);
  assert.equal((await c.syncNow()).synced, 1);                   // same opId sent again
  assert.equal((await serverLessons(c)).length, 1);
  assert.equal(c.plans()[0].status, 'synced');
}));

test('C04 the server stays in charge: a tampered local record is rejected and marked Needs attention', () => withServer(async (base) => {
  const storage = new FakeStorage();
  const c = await signedIn(base, 'FAC-01', '4821', storage);
  c.savePlan(plan());
  const key = 'stemmate:v2:FAC-01';
  const s = JSON.parse(storage.getItem(key));
  s.queue[0].data.durationMin = 1;                               // bypass the client check
  storage.setItem(key, JSON.stringify(s));
  const again = await signedIn(base, 'FAC-01', '4821', storage);
  const r = await again.syncNow();
  assert.equal(r.rejected, 1);
  const p = again.plans()[0];
  assert.equal(p.status, 'attention');
  assert.match(p.errors.durationMin, /5 to 240/);
  assert.equal(again.state.queue.length, 0);
  assert.equal((await serverLessons(again)).length, 0);
}));

test('C05 two devices: a stale edit becomes a real conflict; keep-phone and keep-online both work', () => withServer(async (base) => {
  const A = await signedIn(base);
  A.savePlan(plan({ title: 'Original' }));
  await A.syncNow();
  const B = await signedIn(base);                                // second device, own storage
  await B.syncNow();                                             // pulls the lesson
  assert.equal(B.plans()[0].data.title, 'Original');
  const cid = A.plans()[0].clientId;
  A.savePlan(plan({ title: 'Edited on A' }), cid);
  await A.syncNow();                                             // server is now at version 2
  B.simulateOffline = true;
  B.savePlan(plan({ title: 'Edited on B' }), cid);               // B edits its old copy while offline
  B.simulateOffline = false;
  const r = await B.syncNow();
  assert.equal(r.conflicts, 1);
  const pb = B.plans()[0];
  assert.equal(pb.status, 'conflict');
  assert.equal(pb.serverCopy.title, 'Edited on A');
  assert.equal((await serverLessons(B))[0].title, 'Edited on A'); // nothing overwritten
  assert.equal(B.savePlan(plan(), cid).ok, false);               // must resolve first
  assert.equal(B.resolveConflict(cid, 'phone'), true);
  await B.syncNow();
  assert.equal(B.plans()[0].status, 'synced');
  assert.equal((await serverLessons(B))[0].title, 'Edited on B');
  assert.equal((await serverLessons(B))[0].version, 3);
  // keep-online path
  A.simulateOffline = true;
  A.savePlan(plan({ title: 'Edited on A again' }), cid);
  A.simulateOffline = false;
  assert.equal((await A.syncNow()).conflicts, 1);
  A.resolveConflict(cid, 'online');
  assert.equal(A.plans()[0].data.title, 'Edited on B');
  assert.equal(A.plans()[0].status, 'synced');
  assert.equal(A.state.queue.length, 0);
}));

test('C06 an expired or ended session keeps unsynced work; signing in again lets it sync', () => withServer(async (base) => {
  const storage = new FakeStorage();
  const c = await signedIn(base, 'FAC-01', '4821', storage);
  c.savePlan(plan());
  await c.request('POST', '/api/auth/logout', {});               // session ends on the server
  assert.deepEqual(await c.syncNow(), { unauthorised: true });
  assert.equal(c.token, null);
  assert.equal(c.state.queue.length, 1);
  const again = await signedIn(base, 'FAC-01', '4821', storage);
  assert.equal((await again.syncNow()).synced, 1);
}));

test('C07 deleting: unsynced plans just disappear; synced plans send a delete operation', () => withServer(async (base) => {
  const c = await signedIn(base);
  const a = c.savePlan(plan({ title: 'Never synced' })).plan.clientId;
  c.deletePlan(a);
  assert.equal(c.state.queue.length, 0);
  c.savePlan(plan({ title: 'Synced then deleted' }));
  await c.syncNow();
  c.deletePlan(c.plans()[0].clientId);
  assert.equal(c.plans().length, 0);
  assert.equal(c.state.queue[0].type, 'delete');
  await c.syncNow();
  assert.equal((await serverLessons(c)).length, 0);
}));

test('C08 repeated edits are merged into one queued operation', () => withServer(async (base) => {
  const c = await signedIn(base);
  const id = c.savePlan(plan({ title: 'v1' })).plan.clientId;
  c.savePlan(plan({ title: 'v2' }), id);
  c.savePlan(plan({ title: 'v3' }), id);
  assert.equal(c.state.queue.length, 1);
  assert.equal(c.state.queue[0].type, 'create');
  await c.syncNow();
  c.savePlan(plan({ title: 'v4' }), id);
  c.savePlan(plan({ title: 'v5' }), id);
  assert.equal(c.state.queue.length, 1);
  assert.equal(c.state.queue[0].type, 'update');
  await c.syncNow();
  assert.equal((await serverLessons(c))[0].title, 'v5');
}));

test('C09 activities are cached for offline use', () => withServer(async (base) => {
  const c = await signedIn(base);
  const online = await c.loadActivities();
  assert.equal(online.fromCache, false);
  assert.ok(online.activities.length >= 1);
  c.simulateOffline = true;
  const offline = await c.loadActivities();
  assert.equal(offline.fromCache, true);
  assert.deepEqual(offline.activities, online.activities);
}));

test('C10 export and delete-all work through the client; sign-out can clear the device', () => withServer(async (base) => {
  const storage = new FakeStorage();
  const c = await signedIn(base, 'FAC-01', '4821', storage);
  c.savePlan(plan());
  await c.syncNow();
  const csv = await c.exportFile('csv');
  assert.equal(csv.ok, true);
  assert.match(csv.text, /Fractions with bottle caps/);
  const json = await c.exportFile('json');
  assert.equal(JSON.parse(json.text).lessons.length, 1);
  const del = await c.deleteAllData();
  assert.deepEqual(del, { ok: true, deletedLessons: 1 });
  assert.equal(c.plans().length, 0);
  c.savePlan(plan());
  await c.signOut(true);
  assert.equal(storage.getItem('stemmate:v2:FAC-01'), null);
  assert.equal(c.token, null);
}));

test('C11 sign-in messages: wrong PIN is neutral, lockout gives a wait time, offline is explained', () => withServer(async (base) => {
  const c = new Client({ baseUrl: base, storage: new FakeStorage() });
  const wrong = await c.login('FAC-01', '0000');
  const unknown = await c.login('NOPE-1', '4821');
  assert.equal(wrong.message, unknown.message);
  for (let i = 0; i < 3; i++) await c.login('FAC-01', '0000');
  const locked = await c.login('FAC-01', '0000');
  assert.equal(locked.status, 429);
  assert.equal(locked.retryAfterSec, 300);
  assert.match(locked.message, /minutes/);
  c.simulateOffline = true;
  assert.equal((await c.login('FAC-02', '7365')).offline, true);
}));

test('C12 full storage is reported, not hidden', () => withServer(async (base) => {
  const c = await signedIn(base, 'FAC-01', '4821', new FakeStorage(50));
  const r = c.savePlan(plan());
  assert.equal(r.ok, false);
  assert.equal(r.storageFull, true);
}));

test('C13 client and server give the same messages for the same bad input', () => withServer(async (base) => {
  const c = await signedIn(base);
  const bad = [
    plan({ title: '' }), plan({ subject: 'Cooking' }), plan({ lessonDate: '2999-01-01' }), plan({ lessonDate: '21/10/2026' }),
    plan({ durationMin: 3 }), plan({ durationMin: 45.5 }), plan({ learnerCount: 500 }),
    plan({ materials: 'call 081 123 4567' }), plan({ notes: 'mail a.b@school.edu.na' }), plan({ safety: 'ID 80010112345' }),
    plan({ title: 'x'.repeat(81) }), plan({ steps: 'y'.repeat(1001) })
  ];
  for (const b of bad) {
    const local = validatePlan(b);
    const r = await c.request('POST', '/api/lessons', { ...b, clientId: 'parity-' + Math.random().toString(36).slice(2) });
    assert.equal(r.status, 422, JSON.stringify(b).slice(0, 80));
    assert.deepEqual(local, r.data.error.fields);
  }
  const okPlan = plan({ notes: 'Grade 8, ' + today() + ' 22 learners, 45 min' });
  assert.deepEqual(validatePlan(okPlan), {});
}));

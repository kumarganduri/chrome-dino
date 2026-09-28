// Boots the real server on a temp dir and exercises the HTTP surface.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(path.join(tmpdir(), 'dino-srv-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
const KEY = 'test-deploy-key-0123456789abcdef';
let proc: ChildProcess;

before(async () => {
  proc = spawn(process.execPath, ['server/main.ts'], {
    cwd: root, env: {...process.env, PORT: String(PORT), DATA_DIR: dir, DEPLOY_KEY: KEY, ALLOWED_ORIGINS: 'https://example.test'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => {
  proc.kill('SIGTERM');
  rmSync(dir, {recursive: true, force: true});
});

test('state has a live run, champion and board', async () => {
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.ok(s.run.seed > 0);
  assert.ok(s.run.checkpoint);
  assert.ok(s.champion.genome);
  assert.ok(Array.isArray(s.board.survival));
});

test('CORS only for allowed origins', async () => {
  const ok = await fetch(`${base}/api/state`, {headers: {origin: 'https://example.test'}});
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://example.test');
  const bad = await fetch(`${base}/api/state`, {headers: {origin: 'https://evil.test'}});
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('SSE stream opens with a state event', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/live`, {signal: ctrl.signal});
  const reader = res.body!.getReader();
  const {value} = await reader.read();
  ctrl.abort();
  const text = new TextDecoder().decode(value);
  assert.match(text, /event: state/);
});

test('race is re-played and lands on the board', async () => {
  const res = await fetch(`${base}/api/run`, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({seed: 5, inputs: [], name: 'tester'})});
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.frames > 30 && body.frames < 2000); // no input → crashes at the first cactus
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s.board.humans[0].name, 'tester');
});

test('bad payloads are rejected; oversized bodies are 413', async () => {
  const bad = await fetch(`${base}/api/run`, {method: 'POST', body: '{"seed":1,"inputs":[{"f":-1}]}'});
  assert.equal(bad.status, 400);
  const huge = await fetch(`${base}/api/run`, {method: 'POST', body: 'x'.repeat(40 * 1024)});
  assert.equal(huge.status, 413);
  const stale = await fetch(`${base}/api/attack`, {method: 'POST', body: JSON.stringify({seed: 1, forkFrame: 0, drops: []})});
  assert.equal(stale.status, 409);
});

test('trainer endpoints need the deploy key; unproven candidates are refused', async () => {
  const noKey = await fetch(`${base}/api/trainer/lessons`);
  assert.equal(noKey.status, 401);
  const wrong = await fetch(`${base}/api/trainer/lessons`, {headers: {authorization: 'Bearer nope'}});
  assert.equal(wrong.status, 401);
  const lessons = await fetch(`${base}/api/trainer/lessons`, {headers: {authorization: `Bearer ${KEY}`}});
  assert.equal(lessons.status, 200);
  const s = await (await fetch(`${base}/api/state`)).json();
  const cand = await fetch(`${base}/api/trainer/candidate`, {method: 'POST', headers: {authorization: `Bearer ${KEY}`},
    body: JSON.stringify({genome: s.champion.genome, gen: 1, gate: {seeds: 500, passed: 499}})});
  assert.equal(cand.status, 400);
});

test('rate limit kicks in', async () => {
  let limited = false;
  for (let i = 0; i < 20 && !limited; i++) {
    const r = await fetch(`${base}/api/run`, {method: 'POST', body: JSON.stringify({seed: i, inputs: []})});
    limited = r.status === 429;
  }
  assert.ok(limited);
});

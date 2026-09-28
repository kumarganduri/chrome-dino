// Cross-engine determinism: the same seed and key script must produce the
// same per-frame state, sense vectors and key edges in Node, Chrome, Firefox
// and WebKit. Plus the differential check: our headless construction of the
// Runner must match Chrome's own Runner.initializeInstance() page init.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {chromium, firefox, webkit, type Browser} from 'playwright';
import {serve} from './serve.ts';
import {loadEngine} from '../../src/engine/load.ts';
import {drive, type DriveResult} from '../../src/engine/testdrive.ts';

const SEEDS = Array.from({length: Number(process.env.DET_SEEDS ?? 60)}, (_, i) => 500 + i * 7);
const FRAMES = Number(process.env.DET_FRAMES ?? 20_000);
const root = path.resolve(import.meta.dirname, '../..');
let url = '';
let close: () => void = () => {};

const engine = await loadEngine();
const expected = new Map<number, DriveResult>(SEEDS.map((s) => [s, drive(engine, s, FRAMES)]));

before(async () => {
  const s = await serve(root);
  url = s.url;
  close = () => s.server.close();
});
after(() => close());

function compare(actual: DriveResult[], label: string) {
  for (const a of actual) {
    const e = expected.get(a.seed)!;
    const firstBad = e.checkpoints.findIndex((c, i) => a.checkpoints[i] !== c);
    assert.equal(firstBad, -1, `${label} seed ${a.seed}: state diverges before frame ${(firstBad + 1) * 500}`);
    assert.deepEqual(
        {frames: a.frames, crashed: a.crashed, state: a.stateFold, sense: a.senseFold, edges: a.edgeFold},
        {frames: e.frames, crashed: e.crashed, state: e.stateFold, sense: e.senseFold, edges: e.edgeFold},
        `${label} seed ${a.seed}`);
  }
}

test('workload is non-trivial (long runs, jumps, ducks, fast-falls)', () => {
  const frames = [...expected.values()].map((r) => r.frames);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  assert.ok(avg > 3000, `average run only ${avg} frames`);
});

for (const [name, type, opts] of [
  ['chrome', chromium, {channel: 'chrome'}],
  ['firefox', firefox, {}],
  ['webkit', webkit, {}],
] as const) {
  test(`${name}: identical to Node`, async () => {
    const browser: Browser = await type.launch(opts);
    try {
      const page = await browser.newPage();
      await page.goto(`${url}/test/e2e/harness.html`);
      await page.evaluate(() => (window as any).ready);
      const actual = await page.evaluate(([seeds, frames]) =>
        (seeds as number[]).map((s) => (window as any).core.drive((window as any).core.engine, s, frames)), [SEEDS, FRAMES] as const);
      compare(actual, name);
    } finally {
      await browser.close();
    }
  });
}

test('chrome: Runner.initializeInstance page init matches headless construction', async () => {
  const browser = await chromium.launch({channel: 'chrome'});
  try {
    for (const seed of SEEDS.slice(0, 10)) {
      const page = await browser.newPage();
      await page.goto(`${url}/test/e2e/harness.html`);
      await page.evaluate(() => (window as any).ready);
      const actual = await page.evaluate(([s, f]) => (window as any).pageRunnerDrive(s, f), [seed, FRAMES] as const);
      compare([actual], 'page-init');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

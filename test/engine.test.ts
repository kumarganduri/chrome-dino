import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadEngine} from '../src/engine/load.ts';
import {Game} from '../src/engine/game.ts';
import type {Keys} from '../src/hook/act.ts';

const engine = await loadEngine();

// Deterministic pseudo-random key script so tests exercise jumps, ducks,
// speed drops and short hops, not just running into the first cactus.
function scriptedKeys(seed: number, frame: number): Keys {
  const x = Math.imul(seed ^ Math.imul(frame >> 3, 0x9e3779b1), 0x85ebca6b) >>> 0;
  return {jump: x % 7 === 0 || x % 11 === 0, down: x % 13 === 0};
}

function play(seed: number, frames: number, collect?: (g: Game) => void): Game {
  const g = Game.create(engine, seed);
  for (let f = 0; f < frames && !g.crashed; f++) {
    g.step(scriptedKeys(seed, f));
    collect?.(g);
  }
  return g;
}

test('same seed and keys give identical per-frame hashes', () => {
  for (const seed of [1, 7, 42, 1234567, 0xdeadbeef]) {
    const a: number[] = [];
    const b: number[] = [];
    play(seed, 5000, (g) => a.push(g.coreHash()));
    play(seed, 5000, (g) => b.push(g.coreHash()));
    assert.deepEqual(a, b, `seed ${seed}`);
  }
});

test('different seeds give different obstacle sequences', () => {
  const hashes = new Set<number>();
  for (let seed = 1; seed <= 20; seed++) {
    hashes.add(play(seed, 600).coreHash());
  }
  assert.ok(hashes.size >= 19);
});

test('game uses seeded RNG only inside steps; page Math.random untouched', () => {
  const before = Math.random;
  const g = Game.create(engine, 3);
  g.step();
  assert.equal(Math.random, before);
  assert.ok(g.rng.calls > 0);
});

test('no input crashes into the first obstacle, like the real game', () => {
  const g = play(42, 100_000, undefined);
  const idle = Game.create(engine, 42);
  while (idle.step()) {}
  assert.ok(idle.crashed);
  assert.ok(idle.frame > 60 && idle.frame < 2000, `crash frame ${idle.frame}`);
  assert.ok(g.frame > 0);
});

test('speed ramps with acceleration and caps at maxSpeed', () => {
  const g = Game.create(engine, 5);
  const {speed, maxSpeed, acceleration} = g.runner.config;
  assert.equal(g.runner.currentSpeed, speed);
  g.runner.horizon.obstacles.length = 0;
  // Keep obstacles out of the way to observe the ramp in isolation.
  g.runner.runningTime = -1e12;
  for (let i = 0; i < 10; i++) g.step();
  assert.ok(Math.abs(g.runner.currentSpeed - (speed + 10 * acceleration)) < 1e-9);
  for (let i = 0; i < 20_000 && !g.crashed; i++) g.step();
  assert.equal(g.runner.currentSpeed <= maxSpeed + acceleration, true);
  assert.ok(g.runner.currentSpeed >= maxSpeed);
});

test('snapshot → restore → N steps equals straight N steps', () => {
  for (const seed of [11, 99, 2024]) {
    const straight = Game.create(engine, seed);
    const forked = Game.create(engine, seed);
    for (let f = 0; f < 400; f++) {
      straight.step(scriptedKeys(seed, f));
      forked.step(scriptedKeys(seed, f));
    }
    const snap = forked.snapshot();
    // Scramble the fork, then restore.
    for (let f = 0; f < 300 && !forked.crashed; f++) forked.step({jump: true, down: false});
    forked.restore(JSON.parse(JSON.stringify(snap)));
    assert.equal(forked.fullHash(), straight.fullHash(), `restore mismatch seed ${seed}`);
    for (let f = 400; f < 3000 && !straight.crashed; f++) {
      const k = scriptedKeys(seed, f);
      straight.step(k);
      forked.step(k);
      assert.equal(forked.coreHash(), straight.coreHash(), `diverged seed ${seed} frame ${f}`);
    }
    assert.equal(forked.fullHash(), straight.fullHash());
  }
});

test('snapshot moves between games (restore into a different seed game)', () => {
  const src = play(77, 900);
  const dst = Game.create(engine, 1);
  dst.restore(src.snapshot());
  assert.equal(dst.fullHash(), src.fullHash());
});

test('no state leaks across 1,000 episodes reset by snapshot', () => {
  const pool = Game.create(engine, 0);
  const fresh = pool.snapshot();
  const reference = Game.create(engine, 555);
  const refStart = reference.snapshot();
  const expected: number[] = [];
  for (let f = 0; f < 800 && !reference.crashed; f++) {
    reference.step(scriptedKeys(555, f));
    expected.push(reference.coreHash());
  }
  for (let ep = 0; ep < 1000; ep++) {
    pool.restore(fresh);
    for (let f = 0; f < 60 && !pool.crashed; f++) pool.step(scriptedKeys(ep, f));
  }
  pool.restore(refStart);
  const actual: number[] = [];
  for (let f = 0; f < 800 && !pool.crashed; f++) {
    pool.step(scriptedKeys(555, f));
    actual.push(pool.coreHash());
  }
  assert.deepEqual(actual, expected);
});

test('snapshot version mismatch fails loudly', () => {
  const g = Game.create(engine, 1);
  const snap = {...g.snapshot(), v: 999};
  assert.throws(() => g.restore(snap), /snapshot version 999/);
});

test('run starts where the intro would leave the dino (x = startXPos)', () => {
  const g = Game.create(engine, 9);
  assert.equal(g.runner.tRex.xPos, 50);
  g.step({jump: true, down: false});
  while (g.runner.tRex.jumping) g.step();
  assert.equal(g.runner.tRex.xPos, 50, 'reset() after landing returns to xInitialPos');
});

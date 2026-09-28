import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadEngine} from '../src/engine/load.ts';
import {Game} from '../src/engine/game.ts';
import {installAttackHook, queueDrop, dropCheck} from '../src/hook/attack.ts';
import {plannerKeys} from '../src/oracle/planner.ts';

const engine = await loadEngine();
installAttackHook(engine);

function runTo(g: Game, frames: number) {
  while (g.frame < frames && g.step(plannerKeys(g))) {}
}

test('no queue → Chrome spawns exactly as without the hook', () => {
  const a = Game.create(engine, 31);
  runTo(a, 3000);
  // Same run recorded before the hook existed is covered by determinism tests;
  // here: two hooked games agree and the attack log stays empty.
  const b = Game.create(engine, 31);
  runTo(b, 3000);
  assert.equal(a.fullHash(), b.fullHash());
  assert.equal(a.runner.horizon.attackLog, undefined);
});

test('a legal drop replaces the next spawn with the chosen type', () => {
  const g = Game.create(engine, 32);
  runTo(g, 8000); // past pterodactyl min speed
  const options = [{type: 'pterodactyl', yPos: 75}, {type: 'cactusLarge'}, {type: 'cactusSmall'}] as const;
  const drop = options.find((d) => dropCheck(g, d) === null)!;
  assert.ok(drop, 'some type is legal');
  queueDrop(g, drop);
  const before = g.runner.horizon.obstacles.length;
  let spawned: any = null;
  for (let i = 0; i < 600 && !spawned && !g.crashed; i++) {
    g.step(plannerKeys(g));
    const last = g.runner.horizon.obstacles.at(-1);
    if (g.runner.horizon.attackLog?.length) spawned = last;
  }
  assert.ok(spawned, 'drop spawned');
  assert.equal(spawned.typeConfig.type, drop.type);
  if (drop.type === 'pterodactyl') assert.equal(spawned.yPos, 75);
  assert.ok(before >= 0);
  assert.deepEqual(g.runner.horizon.attackLog[0].accepted, true);
});

test('illegal drops are refused with a reason and Chrome picks instead', () => {
  const g = Game.create(engine, 33);
  runTo(g, 60);
  assert.match(dropCheck(g, {type: 'pterodactyl'})!, /from speed 8.5/);
  queueDrop(g, {type: 'pterodactyl'});
  for (let i = 0; i < 2000 && !g.runner.horizon.attackLog; i++) g.step(plannerKeys(g));
  assert.equal(g.runner.horizon.attackLog[0].accepted, false);
});

test('attacks replay exactly from a snapshot (queue is part of state)', () => {
  const g = Game.create(engine, 34);
  runTo(g, 8200);
  queueDrop(g, {type: 'cactusLarge'});
  const snap = g.snapshot();
  runTo(g, 9500);
  const straight = g.fullHash();
  g.restore(snap);
  runTo(g, 9500);
  assert.equal(g.fullHash(), straight);
});

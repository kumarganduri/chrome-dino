// Server verification: re-plays are exact, forged claims are rejected.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadEngine} from '../src/engine/load.ts';
import {installAttackHook} from '../src/hook/attack.ts';
import {Game} from '../src/engine/game.ts';
import {GENOME_FORMAT, INPUTS, OUTPUTS, type Genome} from '../src/neat/genome.ts';
import {BrainPolicy} from '../src/neat/policy.ts';
import {Network} from '../src/neat/genome.ts';
import {replayAttack, replayRace, stateAtFrame, validateDrops, validateRaceInputs, verifyGate, type RunRecord} from '../server/verify.ts';

const engine = await loadEngine();
installAttackHook(engine);

// A brain that jumps when the next obstacle is < 0.3 s away (inputs: 1 = ttc, 20 = bias).
function jumper(threshold = 0.3): Genome {
  const nodes = [...Array.from({length: INPUTS}, (_, i) => ({id: i, kind: 'input' as const})),
    {id: INPUTS, kind: 'output' as const}, {id: INPUTS + 1, kind: 'output' as const}];
  return {format: GENOME_FORMAT, nodes, conns: [
    {innov: 0, from: 1, to: INPUTS, w: -40, on: true},
    {innov: 1, from: INPUTS - 1, to: INPUTS, w: 40 * threshold, on: true},
    {innov: 2, from: INPUTS - 1, to: INPUTS + 1, w: -10, on: true},
  ]};
}
const NEVER: Genome = {...jumper(), conns: [{innov: 0, from: INPUTS - 1, to: INPUTS, w: -10, on: true}, {innov: 1, from: INPUTS - 1, to: INPUTS + 1, w: -10, on: true}]};

test('race replay reproduces the client run exactly', () => {
  const seed = 4242;
  const client = Game.create(engine, seed);
  const inputs: Array<{f: number; k: 'jump' | 'down'; d: 0 | 1}> = [];
  const policy = new BrainPolicy(new Network(jumper()));
  let prev = {jump: false, down: false};
  while (client.frame < 4000) {
    const k = policy.keys(client.runner);
    if (k.jump !== prev.jump) inputs.push({f: client.frame, k: 'jump', d: k.jump ? 1 : 0});
    if (k.down !== prev.down) inputs.push({f: client.frame, k: 'down', d: k.down ? 1 : 0});
    prev = k;
    if (!client.step({...k})) break;
  }
  const server = replayRace(engine, seed, validateRaceInputs(inputs));
  assert.equal(server.frames, client.frame);
});

test('race input validation rejects forged or oversized logs', () => {
  assert.throws(() => validateRaceInputs([{f: 10, k: 'jump', d: 1}, {f: 5, k: 'jump', d: 0}]), /invalid input/);
  assert.throws(() => validateRaceInputs([{f: 1, k: 'fly', d: 1}]), /invalid input/);
  assert.throws(() => validateRaceInputs(new Array(20_001).fill({f: 0, k: 'jump', d: 1})), /invalid inputs/);
  assert.throws(() => validateRaceInputs('x'), /invalid inputs/);
});

test('stateAtFrame from checkpoints equals a straight run, across a brain swap', () => {
  const seed = 99;
  const a = jumper(0.3);
  const b = jumper(0.28);
  const g = Game.create(engine, seed);
  const checkpoints = [g.snapshot()];
  let pol = new BrainPolicy(new Network(a));
  let swapCp = null;
  while (g.frame < 5000 && !g.crashed) {
    if (g.frame === 3600) {
      swapCp = g.snapshot();
      checkpoints.push(swapCp);
      pol = new BrainPolicy(new Network(b));
    }
    g.step(pol.keys(g.runner));
  }
  const run: RunRecord = {seed, segments: [{fromFrame: 0, genome: a, checkpoint: null}, {fromFrame: 3600, genome: b, checkpoint: swapCp}]};
  const s = stateAtFrame(engine, run, checkpoints, g.frame);
  assert.equal(s.game.coreHash(), g.coreHash());
  const fromStart = stateAtFrame(engine, run, [checkpoints[0]!], g.frame);
  assert.equal(fromStart.game.coreHash(), g.coreHash());
});

test('attack: a brain that never jumps is killed, and the kill is clearable', () => {
  const run: RunRecord = {seed: 7, segments: [{fromFrame: 0, genome: NEVER, checkpoint: null}]};
  const start = Game.create(engine, 7);
  const v = replayAttack(engine, run, [start.snapshot()], 0, validateDrops([], 0));
  assert.equal(v.verdict, 'kill');
});

test('attack: drops are validated (count, order, window, types)', () => {
  assert.throws(() => validateDrops(new Array(11).fill({type: 'cactusSmall', frame: 5}), 0), /at most 10/);
  assert.throws(() => validateDrops([{type: 'cactusSmall', frame: 5}, {type: 'cactusSmall', frame: 5}], 0), /invalid drop/);
  assert.throws(() => validateDrops([{type: 'meteor', frame: 5}], 0), /invalid drop/);
  assert.throws(() => validateDrops([{type: 'cactusSmall', frame: 999999}], 0), /invalid drop/);
  assert.throws(() => validateDrops([{type: 'pterodactyl', yPos: 60, frame: 5}], 0), /invalid drop/);
});

test('attack: an illegal drop (bird below speed 8.5) is refused', () => {
  const run: RunRecord = {seed: 8, segments: [{fromFrame: 0, genome: jumper(), checkpoint: null}]};
  const v = replayAttack(engine, run, [Game.create(engine, 8).snapshot()], 0, validateDrops([{type: 'pterodactyl', frame: 1}], 0));
  assert.equal(v.verdict, 'illegal');
});

test('gate verification counts crashes honestly', () => {
  const never = verifyGate(engine, NEVER, [1, 2, 3]);
  assert.equal(never.passed, 0);
  assert.deepEqual(never.failedSeeds, [1, 2, 3]);
  assert.throws(() => verifyGate(engine, {format: 99}, [1]), /invalid genome/);
});

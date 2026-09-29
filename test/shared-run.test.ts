// The published shared run (web/data/live) must be one continuous run of the
// published champion: every hourly checkpoint, played forward one hour, lands
// exactly on the next checkpoint without a crash.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {loadEngine} from '../src/engine/load.ts';
import {Game} from '../src/engine/game.ts';
import {BrainPolicy} from '../src/neat/policy.ts';
import {Network} from '../src/neat/genome.ts';

const dir = path.join(import.meta.dirname, '../web/data/live');
const has = existsSync(path.join(dir, 'run.json'));

test('shared run checkpoints chain with the published champion', {skip: !has && 'no shared run published'}, async () => {
  const run = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8'));
  const champion = JSON.parse(readFileSync(path.join(dir, '../champion.json'), 'utf8'));
  assert.equal(run.championVersion, champion.version, 'shared run was computed with a different champion');
  const engine = await loadEngine();
  const policy = new BrainPolicy(new Network(champion.genome));
  const load = (f: number) => JSON.parse(readFileSync(path.join(dir, `${f}.json`), 'utf8'));
  // Frame 0 is exactly Game.create(seed).
  const fresh = Game.create(engine, run.seed);
  const probe = Game.create(engine, 0);
  probe.restore(load(0));
  assert.equal(probe.fullHash(), fresh.fullHash());
  // Spot-check the first two hours and the last hour.
  const last = run.verifiedUntilFrame - run.checkpointEvery;
  for (const from of [0, run.checkpointEvery, last]) {
    const g = Game.create(engine, 0);
    g.restore(load(from));
    while (g.frame < from + run.checkpointEvery) assert.ok(g.step(policy.keys(g.runner)), `crash at frame ${g.frame}`);
    const next = Game.create(engine, 0);
    next.restore(load(from + run.checkpointEvery));
    assert.equal(g.fullHash(), next.fullHash(), `checkpoint ${from + run.checkpointEvery} does not follow from ${from}`);
  }
});

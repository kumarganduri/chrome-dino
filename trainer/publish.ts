// Exports training results as the static site's data (web/data/*.json).
//
//   out/train/champion.json   → champion.json   (gate-proven brain, if any)
//   out/train/leader.json     → leader.json     (best brain so far)
//   out/train/history.json    → history.json    (≤ 600 evenly spaced rows)
//   out/train/graveyard.json  → graveyard.json  (newest 60 with replay data)
//   + stats.json (totals, oracle feasibility summary)
//
//   node trainer/publish.ts [--from out/train] [--to web/data]
import {parseArgs} from 'node:util';
import path from 'node:path';
import {readJson, writeJsonAtomic} from './store.ts';

const {values: args} = parseArgs({options: {from: {type: 'string', default: 'out/train'}, to: {type: 'string', default: 'web/data'}}});
const from = (f: string) => path.join(args.from!, f);
const to = (f: string) => path.join(args.to!, f);

const champion = readJson<any>(from('champion.json'), null);
const leader = readJson<any>(from('leader.json'), null);
const history = readJson<any[]>(from('history.json'), []);
const graveyard = readJson<any[]>(from('graveyard.json'), []);
const curriculum = readJson<any[]>(from('curriculum.json'), []);
const oracle = readJson<any>('out/oracle-sweep.json', null);
const latestValidation = readJson<any>('out/validation.json', null);
const validationOf = (v: number | undefined) => (v ? readJson<any>(`out/validation-v${v}.json`, null) : null);

// Only a champion with a perfect held-out validation (trainer/validate.ts)
// replaces the published one: passing the gate is necessary, not sufficient
// (v4 passed every gate stage, then crashed 5× in 2,000 unseen 3-hour runs).
const published = readJson<any>(to('champion.json'), null);
const candidateValidation = validationOf(champion?.version) ?? (latestValidation?.version === champion?.version ? latestValidation : null);
const validated = champion && candidateValidation && candidateValidation.survived === candidateValidation.seeds;
if (champion && (validated || !published)) {
  writeJsonAtomic(to('champion.json'), champion);
} else if (champion && published) {
  console.log(`keeping published champion v${published.version}: v${champion.version} has no perfect held-out validation ` +
    `(run node trainer/validate.ts --seeds 2000 --minutes 180)`);
}
if (leader) writeJsonAtomic(to('leader.json'), leader);

const step = Math.max(1, Math.ceil(history.length / 600));
const thin = history.filter((_, i) => i % step === 0 || i === history.length - 1)
    .map((r) => ({gen: r.gen, best: +r.best.toFixed(4), mean: +r.mean.toFixed(4), gateTried: r.gateTried, champion: r.champion}));
writeJsonAtomic(to('history.json'), thin);

const replayable = graveyard.filter((g) => g.snapshot && g.genome).slice(-60);
writeJsonAtomic(to('graveyard.json'), replayable);
// Latest lessons (curriculum): the champion can replay each one to show how
// it handles a past crash now; with the crashing genome, the original too.
const lessons = curriculum.slice().sort((a, b) => b.gen - a.gen).slice(0, 60)
    .map((c) => ({id: c.id, gen: c.gen, source: c.source, speed: c.speed, obstacles: c.obstacles, snapshot: c.snapshot,
      genome: c.genome ?? null, unclearable: !!c.unclearable}));
writeJsonAtomic(to('lessons.json'), lessons);

writeJsonAtomic(to('stats.json'), {
  generations: history.length ? history.at(-1).gen + 1 : 0,
  framesSimulated: history.reduce((a, r) => a + (r.framesSimulated ?? 0), 0),
  curriculum: curriculum.length,
  championVersion: readJson<any>(to('champion.json'), null)?.version ?? null,
  publishedAt: new Date().toISOString(),
  oracle: oracle ? {seeds: oracle.summary.seeds, survived: oracle.summary.survived, gameHoursPerSeed: oracle.summary.gameHoursPerSeed} : null,
  // Held-out validation of the published champion (trainer/validate.ts), only if it matches.
  validation: ((validation) => validation ?
    {seeds: validation.seeds, survived: validation.survived, minutes: validation.minutesAtTopSpeed,
      gameHours: Math.round(validation.gameHours), crashes: validation.crashes.length} : null)(validationOf(readJson<any>(to('champion.json'), null)?.version)),
});
console.log(`published: champion v${readJson<any>(to('champion.json'), null)?.version ?? '-'}, leader gen ${leader?.gen ?? '-'}, ` +
  `${thin.length} history rows, ${replayable.length} graves, ${lessons.length} lessons`);

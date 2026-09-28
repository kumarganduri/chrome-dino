// Headless NEAT trainer.
//
//   each generation:
//     episodes = 5 fresh seeds (new each gen) + up to 3 curriculum cases
//     workers evaluate all genomes  ─►  fitness = mean(frames / cap per episode)
//                                        × 0.5 per failed curriculum case
//     best genome re-run with recording ─► crashes → graveyard + curriculum
//     best survives every episode ─► gate: 50 seeds × 30 min at max speed,
//                                    then 500 seeds ─► promote to champion
//     population.advance(fitness); write out/*.json atomically
//
//   node trainer/train.ts [--gens N] [--seed S] [--out out] [--gate-seeds 500]
import {parseArgs} from 'node:util';
import path from 'node:path';
import {Pool} from './pool.ts';
import {Population, DEFAULT_NEAT, type PopulationState} from '../src/neat/population.ts';
import type {Genome} from '../src/neat/genome.ts';
import {Rng} from '../src/hook/rng.ts';
import {readJson, writeJsonAtomic} from './store.ts';
import {CASE_CAP, GATE_CAP, GATE_SEED_BASE, TRAIN_CAP, type CrashRecord, type Episode, type EpisodeResult} from './episodes.ts';

const {values: args} = parseArgs({
  options: {
    gens: {type: 'string', default: '1000000'},
    seed: {type: 'string', default: '1'},
    out: {type: 'string', default: 'out'},
    'gate-seeds': {type: 'string', default: '500'},
    'quick-gate-seeds': {type: 'string', default: '50'},
  },
});
const OUT = args.out!;
const file = (name: string) => path.join(OUT, name);
const FRESH_PER_GEN = 5;
const CASES_PER_GEN = 3;
const CASES_WHEN_SATURATED = 12; // once fresh runs stop discriminating
const CURRICULUM_MAX = 500;

export interface CurriculumCase {
  id: string;
  signature: string;
  source: 'training' | 'gate' | 'live' | 'attack';
  gen: number;
  obstacles: string;
  speed: number;
  snapshot: CrashRecord['snapshot'];
  clearedBy?: number; // champion version that first passed it
  unclearable?: boolean; // the lookahead oracle cannot survive it either
}

export interface GraveEntry {
  gen: number;
  frames: number;
  speed: number;
  obstacles: string;
  source: string;
  caseId: string;
  seed?: number;
  genomeId: number;
  genome?: Genome; // kept for the newest entries so the page can replay them
  snapshot?: CrashRecord['snapshot'];
}

export interface HistoryRow {
  gen: number;
  best: number;
  mean: number;
  species: number;
  nodes: number;
  conns: number;
  bestFrames: number;
  gateTried: boolean;
  champion: number | null;
  ms: number;
  framesSimulated: number;
}

export interface Champion {
  version: number;
  gen: number;
  genomeId: number;
  fitness: number;
  genome: Genome;
  gate: {seeds: number; passed: number; framesPerSeed: number; firstSeed: number} | null;
  promotedAt: string;
}

const pool = new Pool();
const state = readJson<PopulationState | null>(file('population.json'), null);
const pop = state ? Population.fromJSON(state) : Population.create(Number(args.seed), DEFAULT_NEAT);
const curriculum = readJson<CurriculumCase[]>(file('curriculum.json'), []);
const graveyard = readJson<GraveEntry[]>(file('graveyard.json'), []);
const history = readJson<HistoryRow[]>(file('history.json'), []);
let champion = readJson<Champion | null>(file('champion.json'), null);
let leader = readJson<{gen: number; fitness: number; genome: Genome} | null>(file('leader.json'), null);
const seedRng = new Rng(Number(args.seed) * 7919 + pop.generation);
// Cases that made the latest full gate fail. They block promotion, so every
// generation trains on all of them (hard-example mining) until they pass.
let blocking = readJson<string[]>(file('blocking.json'), []);

async function evaluate(genomes: Genome[], episodes: Episode[], record = false): Promise<EpisodeResult[][]> {
  const chunk = Math.ceil(genomes.length / pool.size);
  const parts: Promise<EpisodeResult[][]>[] = [];
  for (let i = 0; i < genomes.length; i += chunk) {
    parts.push(pool.run({kind: 'eval', genomes: genomes.slice(i, i + chunk), episodes, record}));
  }
  return (await Promise.all(parts)).flat();
}

async function evaluateSeeds(genome: Genome, seeds: number[], cap: number, record: boolean): Promise<EpisodeResult[]> {
  // Spread one genome's seeds across workers.
  const per = Math.ceil(seeds.length / pool.size);
  const parts: Promise<EpisodeResult[][]>[] = [];
  for (let i = 0; i < seeds.length; i += per) {
    const episodes: Episode[] = seeds.slice(i, i + per).map((seed) => ({kind: 'fresh', seed, cap}));
    parts.push(pool.run({kind: 'eval', genomes: [genome], episodes, record}));
  }
  return (await Promise.all(parts)).flatMap((r) => r[0]!);
}

// Fitness = mean fresh survival × (0.5 + 0.5 × curriculum survival).
// Fresh episodes carry the learning signal early; once genomes survive them
// all, past crashes (curriculum) decide who is better. A hard case can at most
// halve an otherwise good genome.
// Promotion still requires every clearable case.
function fitnessOf(results: EpisodeResult[], episodes: Episode[]): number {
  let fresh = 0;
  let freshN = 0;
  let cases = 0;
  let casesN = 0;
  results.forEach((r, i) => {
    const share = r.frames / episodes[i]!.cap;
    if (episodes[i]!.kind === 'fresh') {
      fresh += share;
      freshN++;
    } else {
      cases += share;
      casesN++;
    }
  });
  const f = freshN ? fresh / freshN : 0;
  return casesN ? f * (0.5 + 0.5 * (cases / casesN)) : f;
}

const GRAVE_REPLAYABLE = 150;

function addCrash(crash: CrashRecord, source: CurriculumCase['source'], gen: number, genomeId: number, seed?: number, genome?: Genome): string {
  let c = curriculum.find((x) => x.signature === crash.signature);
  if (c) {
    // Same killer again: keep the lesson current. The snapshot is the state
    // today's genomes actually reach, not the one an ancestor reached.
    c.snapshot = crash.snapshot;
    c.gen = gen;
    delete c.clearedBy;
  } else {
    c = {id: `c${gen}-${curriculum.length}-${crash.signature.length}`, signature: crash.signature, source, gen,
      obstacles: crash.obstacles, speed: crash.speed, snapshot: crash.snapshot};
    curriculum.push(c);
    if (curriculum.length > CURRICULUM_MAX) {
      // Drop the oldest case the current champion already clears.
      const idx = curriculum.findIndex((x) => x.clearedBy !== undefined);
      curriculum.splice(idx >= 0 ? idx : 0, 1);
    }
  }
  graveyard.push({gen, frames: crash.frame, speed: crash.speed, obstacles: crash.obstacles, source, caseId: c.id, seed, genomeId,
    genome, snapshot: crash.snapshot});
  if (graveyard.length > 2000) graveyard.splice(0, graveyard.length - 2000);
  for (let i = 0; i < graveyard.length - GRAVE_REPLAYABLE; i++) {
    delete graveyard[i]!.genome;
    delete graveyard[i]!.snapshot;
  }
  return c.id;
}

function persist(): void {
  writeJsonAtomic(file('blocking.json'), blocking);
  writeJsonAtomic(file('population.json'), pop.toJSON());
  writeJsonAtomic(file('curriculum.json'), curriculum);
  writeJsonAtomic(file('graveyard.json'), graveyard);
  writeJsonAtomic(file('history.json'), history);
  if (champion) writeJsonAtomic(file('champion.json'), champion);
  if (leader) writeJsonAtomic(file('leader.json'), leader);
}

async function gate(genome: Genome, gen: number, genomeId: number, seeds: number): Promise<{passed: number; seeds: number; failedCases: string[]}> {
  const list = Array.from({length: seeds}, (_, i) => GATE_SEED_BASE + i);
  const results = await evaluateSeeds(genome, list, GATE_CAP, true);
  let passed = 0;
  const failedCases: string[] = [];
  results.forEach((r, i) => {
    if (r.survived) passed++;
    else if (r.crash) failedCases.push(addCrash(r.crash, 'gate', gen, genomeId, list[i], genome));
  });
  return {passed, seeds, failedCases};
}

let stop = false;
process.on('SIGINT', () => {
  if (stop) process.exit(130);
  stop = true;
  console.log('\nstopping after this generation (Ctrl-C again to abort)…');
});

// Lessons pulled from the live server (trainer/sync.ts): live-run crashes and
// verified visitor kills join the curriculum like training crashes.
function mergeInbox(gen: number): void {
  const inbox = readJson<any[]>(file('inbox.json'), []);
  if (!inbox.length) return;
  for (const l of inbox) {
    const signature = `server:${l.kind}:${l.id}`;
    if (curriculum.some((c) => c.signature === signature)) continue;
    curriculum.push({id: `s${l.id}`, signature, source: l.kind === 'attack' ? 'attack' : 'live', gen,
      obstacles: l.obstacles ?? '', speed: l.speed ?? 13, snapshot: l.snapshot});
    graveyard.push({gen, frames: l.frames ?? 0, speed: l.speed ?? 13, obstacles: l.obstacles ?? '',
      source: l.kind === 'attack' ? `killed by ${l.name}` : 'live run', caseId: `s${l.id}`, genomeId: -1});
  }
  writeJsonAtomic(file('inbox.json'), []);
  console.log(`  merged ${inbox.length} server lesson(s) into the curriculum`);
}

const maxGens = Number(args.gens);
for (let n = 0; n < maxGens && !stop; n++) {
  const t0 = performance.now();
  const gen = pop.generation;
  mergeInbox(gen);
  const episodes: Episode[] = [];
  for (let i = 0; i < FRESH_PER_GEN; i++) episodes.push({kind: 'fresh', seed: (seedRng.next() * 2 ** 31) >>> 0, cap: TRAIN_CAP});
  // Curriculum sample, weighted toward the lessons that still kill good
  // genomes: gate failures (30-min max-speed runs) and top-speed crashes.
  const open = curriculum.filter((c) => c.clearedBy === undefined);
  const pickFrom = open.length ? open : curriculum;
  const saturated = (history.at(-1)?.best ?? 0) >= 0.999;
  const weights = pickFrom.map((c) => (c.source === 'gate' ? 4 : 1) * (c.speed >= 12 ? 2 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const picked = new Set<number>();
  const want = Math.min(saturated ? CASES_WHEN_SATURATED : CASES_PER_GEN, pickFrom.length);
  while (picked.size < want) {
    let x = seedRng.next() * total;
    let i = 0;
    while (x >= weights[i]!) x -= weights[i++]!;
    picked.add(Math.min(i, pickFrom.length - 1));
  }
  const chosen = new Set<string>();
  for (const id of blocking) {
    const c = curriculum.find((x) => x.id === id);
    if (c && !chosen.has(c.id)) {
      chosen.add(c.id);
      episodes.push({kind: 'case', id: c.id, snapshot: c.snapshot, cap: CASE_CAP});
    }
  }
  for (const i of picked) {
    const c = pickFrom[i]!;
    if (chosen.has(c.id)) continue;
    chosen.add(c.id);
    episodes.push({kind: 'case', id: c.id, snapshot: c.snapshot, cap: CASE_CAP});
  }
  const genomes = pop.members.map((m) => m.genome);
  const results = await evaluate(genomes, episodes);
  const fitness = results.map((r) => fitnessOf(r, episodes));
  let framesSimulated = results.reduce((a, rs) => a + rs.reduce((b, r) => b + r.frames, 0), 0);

  const bestIdx = fitness.indexOf(Math.max(...fitness));
  const best = pop.members[bestIdx]!;
  const bestResults = results[bestIdx]!;
  // Blocking cases the best genome now clears are done.
  const passed = new Set(episodes.map((e, i) => (e.kind === 'case' && bestResults[i]!.survived ? e.id : '')).filter(Boolean));
  blocking = blocking.filter((id) => !passed.has(id));
  // Record the best genome's crashes (deterministic re-run with snapshots).
  const crashed = bestResults.map((r, i) => (!r.survived ? i : -1)).filter((i) => i >= 0);
  if (crashed.length) {
    const rec = (await evaluate([best.genome], crashed.map((i) => episodes[i]!), true))[0]!;
    rec.forEach((r, k) => {
      const ep = episodes[crashed[k]!]!;
      if (r.crash && ep.kind === 'fresh') addCrash(r.crash, 'training', gen, best.id, ep.seed, best.genome);
      if (r.crash && ep.kind === 'case') graveyard.push({gen, frames: r.crash.frame, speed: r.crash.speed, obstacles: r.crash.obstacles, source: 'curriculum', caseId: ep.id, genomeId: best.id});
    });
  }
  if (!leader || fitness[bestIdx]! >= leader.fitness) leader = {gen, fitness: fitness[bestIdx]!, genome: best.genome};

  let gateTried = false;
  if (bestResults.every((r) => r.survived)) {
    gateTried = true;
    const quick = await gate(best.genome, gen, best.id, Number(args['quick-gate-seeds']));
    framesSimulated += quick.passed * GATE_CAP;
    console.log(`  gen ${gen}: quick gate ${quick.passed}/${quick.seeds}`);
    if (quick.failedCases.length) blocking = [...new Set([...blocking, ...quick.failedCases])];
    if (quick.passed === quick.seeds) {
      const full = await gate(best.genome, gen, best.id, Number(args['gate-seeds']));
      framesSimulated += full.passed * GATE_CAP;
      console.log(`  gen ${gen}: FULL gate ${full.passed}/${full.seeds}`);
      blocking = [...new Set([...blocking, ...full.failedCases])];
      if (full.passed === full.seeds) {
        // Must also clear every clearable curriculum case.
        const lessons = curriculum.filter((c) => !c.unclearable);
        const cases: Episode[] = lessons.map((c) => ({kind: 'case', id: c.id, snapshot: c.snapshot, cap: CASE_CAP}));
        const caseRes = cases.length ? (await evaluate([best.genome], cases))[0]! : [];
        const version = (champion?.version ?? 0) + 1;
        const failed = lessons.filter((_, i) => !caseRes[i]!.survived);
        // Only clearable lessons block promotion: judge each failure with the oracle.
        const verdicts = await Promise.all(failed.map((c) => pool.run<boolean>({kind: 'clearable', snapshot: c.snapshot})));
        failed.forEach((c, i) => {
          if (!verdicts[i]) c.unclearable = true;
        });
        const blockers = failed.filter((c) => !c.unclearable);
        const failures = blockers.length;
        console.log(`  gen ${gen}: curriculum ${caseRes.length - failed.length}/${caseRes.length}` +
          (failed.length ? ` (${failed.length - blockers.length} unclearable, ${blockers.length} blocking)` : ''));
        blocking = [...new Set([...blocking, ...blockers.map((c) => c.id)])];
        if (failures === 0) {
          lessons.forEach((c, i) => {
            if (caseRes[i]!.survived) c.clearedBy ??= version;
          });
          champion = {version, gen, genomeId: best.id, fitness: fitness[bestIdx]!, genome: best.genome,
            gate: {seeds: full.seeds, passed: full.passed, framesPerSeed: GATE_CAP, firstSeed: GATE_SEED_BASE},
            promotedAt: new Date().toISOString()};
          console.log(`  ★ champion v${version} promoted (gen ${gen})`);
          blocking = [];
        }
      }
    }
  }

  const mean = fitness.reduce((a, b) => a + b, 0) / fitness.length;
  history.push({
    gen, best: fitness[bestIdx]!, mean, species: pop.species.length,
    nodes: best.genome.nodes.length, conns: best.genome.conns.filter((c) => c.on).length,
    bestFrames: Math.max(...bestResults.map((r) => r.frames)), gateTried, champion: champion?.version ?? null,
    ms: Math.round(performance.now() - t0), framesSimulated,
  });
  pop.advance(fitness);
  persist();
  const h = history.at(-1)!;
  console.log(`gen ${gen}: best ${h.best.toFixed(3)} mean ${mean.toFixed(3)} species ${h.species} ` +
    `nodes ${h.nodes} conns ${h.conns} curriculum ${curriculum.length} ${h.ms}ms ${(framesSimulated / h.ms / 1000).toFixed(1)}M fps`);
  if (champion && champion.gen === gen && args.gens === '1000000' && process.env.STOP_ON_CHAMPION) break;
}
await pool.close();

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

function fitnessOf(results: EpisodeResult[], episodes: Episode[]): number {
  let sum = 0;
  let penalty = 1;
  results.forEach((r, i) => {
    sum += r.frames / episodes[i]!.cap;
    if (episodes[i]!.kind === 'case' && !r.survived) penalty *= 0.5;
  });
  return (sum / results.length) * penalty;
}

function addCrash(crash: CrashRecord, source: CurriculumCase['source'], gen: number, genomeId: number, seed?: number): void {
  let c = curriculum.find((x) => x.signature === crash.signature);
  if (!c) {
    c = {id: `c${gen}-${curriculum.length}-${crash.signature.length}`, signature: crash.signature, source, gen,
      obstacles: crash.obstacles, speed: crash.speed, snapshot: crash.snapshot};
    curriculum.push(c);
    if (curriculum.length > CURRICULUM_MAX) {
      // Drop the oldest case the current champion already clears.
      const idx = curriculum.findIndex((x) => x.clearedBy !== undefined);
      curriculum.splice(idx >= 0 ? idx : 0, 1);
    }
  }
  graveyard.push({gen, frames: crash.frame, speed: crash.speed, obstacles: crash.obstacles, source, caseId: c.id, seed, genomeId});
  if (graveyard.length > 2000) graveyard.splice(0, graveyard.length - 2000);
}

function persist(): void {
  writeJsonAtomic(file('population.json'), pop.toJSON());
  writeJsonAtomic(file('curriculum.json'), curriculum);
  writeJsonAtomic(file('graveyard.json'), graveyard);
  writeJsonAtomic(file('history.json'), history);
  if (champion) writeJsonAtomic(file('champion.json'), champion);
  if (leader) writeJsonAtomic(file('leader.json'), leader);
}

async function gate(genome: Genome, gen: number, genomeId: number, seeds: number): Promise<{passed: number; seeds: number}> {
  const list = Array.from({length: seeds}, (_, i) => GATE_SEED_BASE + i);
  const results = await evaluateSeeds(genome, list, GATE_CAP, true);
  let passed = 0;
  results.forEach((r, i) => {
    if (r.survived) passed++;
    else if (r.crash) addCrash(r.crash, 'gate', gen, genomeId, list[i]);
  });
  return {passed, seeds};
}

let stop = false;
process.on('SIGINT', () => {
  if (stop) process.exit(130);
  stop = true;
  console.log('\nstopping after this generation (Ctrl-C again to abort)…');
});

const maxGens = Number(args.gens);
for (let n = 0; n < maxGens && !stop; n++) {
  const t0 = performance.now();
  const gen = pop.generation;
  const episodes: Episode[] = [];
  for (let i = 0; i < FRESH_PER_GEN; i++) episodes.push({kind: 'fresh', seed: (seedRng.next() * 2 ** 31) >>> 0, cap: TRAIN_CAP});
  const open = curriculum.filter((c) => c.clearedBy === undefined);
  const pickFrom = open.length ? open : curriculum;
  for (let i = 0; i < Math.min(CASES_PER_GEN, pickFrom.length); i++) {
    const c = pickFrom[Math.floor(seedRng.next() * pickFrom.length)]!;
    episodes.push({kind: 'case', id: c.id, snapshot: c.snapshot, cap: CASE_CAP});
  }
  const genomes = pop.members.map((m) => m.genome);
  const results = await evaluate(genomes, episodes);
  const fitness = results.map((r) => fitnessOf(r, episodes));
  let framesSimulated = results.reduce((a, rs) => a + rs.reduce((b, r) => b + r.frames, 0), 0);

  const bestIdx = fitness.indexOf(Math.max(...fitness));
  const best = pop.members[bestIdx]!;
  const bestResults = results[bestIdx]!;
  // Record the best genome's crashes (deterministic re-run with snapshots).
  const crashed = bestResults.map((r, i) => (!r.survived ? i : -1)).filter((i) => i >= 0);
  if (crashed.length) {
    const rec = (await evaluate([best.genome], crashed.map((i) => episodes[i]!), true))[0]!;
    rec.forEach((r, k) => {
      const ep = episodes[crashed[k]!]!;
      if (r.crash && ep.kind === 'fresh') addCrash(r.crash, 'training', gen, best.id, ep.seed);
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
    if (quick.passed === quick.seeds) {
      const full = await gate(best.genome, gen, best.id, Number(args['gate-seeds']));
      framesSimulated += full.passed * GATE_CAP;
      console.log(`  gen ${gen}: FULL gate ${full.passed}/${full.seeds}`);
      if (full.passed === full.seeds) {
        // Must also clear every clearable curriculum case.
        const cases: Episode[] = curriculum.map((c) => ({kind: 'case', id: c.id, snapshot: c.snapshot, cap: CASE_CAP}));
        const caseRes = cases.length ? (await evaluate([best.genome], cases))[0]! : [];
        const version = (champion?.version ?? 0) + 1;
        const failures = caseRes.filter((r) => !r.survived).length;
        console.log(`  gen ${gen}: curriculum ${caseRes.length - failures}/${caseRes.length}`);
        if (failures === 0) {
          caseRes.forEach((_, i) => (curriculum[i]!.clearedBy ??= version));
          champion = {version, gen, genomeId: best.id, fitness: fitness[bestIdx]!, genome: best.genome,
            gate: {seeds: full.seeds, passed: full.passed, framesPerSeed: GATE_CAP, firstSeed: GATE_SEED_BASE},
            promotedAt: new Date().toISOString()};
          console.log(`  ★ champion v${version} promoted (gen ${gen})`);
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

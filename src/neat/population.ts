// NEAT evolution: speciation, fitness sharing, stagnation, crossover, mutation.
//
//   evaluate(genomes) ─► fitness[]            (done by the caller / workers)
//   population.advance(fitness)
//     ├─ speciate: δ = c1·E/N + c2·D/N + c3·W̄  vs. per-species representative
//     ├─ adjust threshold toward the target species count
//     ├─ cull species stagnant for `stagnation` gens (always keep the best 2)
//     ├─ offspring per species ∝ Σ shared fitness (fitness / species size)
//     └─ each child: elite copy | crossover(p1, p2) | clone, then mutate
//
// All randomness comes from this population's own seeded Rng, so a training
// run is reproducible from (seed, config).
import {Rng} from '../hook/rng.ts';
import {GENOME_FORMAT, INPUTS, OUTPUTS, Network, type ConnGene, type Genome, type NodeGene} from './genome.ts';

export interface NeatConfig {
  populationSize: number;
  c1: number;
  c2: number;
  c3: number;
  threshold: number;
  targetSpecies: [number, number];
  thresholdStep: number;
  weightMutateRate: number;
  weightPerturbRate: number;
  weightPerturbSigma: number;
  weightRange: number;
  weightClamp: number;
  addConnRate: number;
  addNodeRate: number;
  toggleRate: number;
  crossoverRate: number;
  interspeciesRate: number;
  elitismMinSize: number;
  stagnation: number;
  survivalFraction: number;
}

export const DEFAULT_NEAT: NeatConfig = {
  populationSize: 150,
  c1: 1,
  c2: 1,
  c3: 0.4,
  threshold: 3,
  targetSpecies: [8, 12],
  thresholdStep: 0.1,
  weightMutateRate: 0.8,
  weightPerturbRate: 0.9,
  weightPerturbSigma: 0.5,
  weightRange: 2,
  weightClamp: 30,
  addConnRate: 0.05,
  addNodeRate: 0.03,
  toggleRate: 0.01,
  crossoverRate: 0.75,
  interspeciesRate: 0.001,
  elitismMinSize: 5,
  stagnation: 15,
  survivalFraction: 0.3,
};

export interface Member {
  id: number;
  genome: Genome;
  fitness: number;
  species: number;
}

export interface Species {
  id: number;
  representative: Genome;
  members: Member[];
  bestFitness: number;
  lastImproved: number;
}

export interface PopulationState {
  generation: number;
  rng: {state: number; calls: number};
  nextMemberId: number;
  nextNodeId: number;
  nextInnov: number;
  innovations: Array<[string, number]>;
  splits: Array<[number, number]>;
  threshold: number;
  members: Member[];
  species: Array<Omit<Species, 'members'> & {memberIds: number[]}>;
  nextSpeciesId: number;
}

export class Population {
  readonly config: NeatConfig;
  readonly rng: Rng;
  generation = 0;
  members: Member[] = [];
  species: Species[] = [];
  threshold: number;
  private nextMemberId = 0;
  private nextSpeciesId = 0;
  private nextNodeId = INPUTS + OUTPUTS;
  private nextInnov = 0;
  private readonly innovations = new Map<string, number>(); // "from>to" → innov
  private readonly splits = new Map<number, number>(); // split conn innov → node id

  constructor(seed: number, config: NeatConfig = DEFAULT_NEAT) {
    this.config = config;
    this.rng = new Rng(seed);
    this.threshold = config.threshold;
  }

  static create(seed: number, config: NeatConfig = DEFAULT_NEAT): Population {
    const p = new Population(seed, config);
    for (let i = 0; i < config.populationSize; i++) {
      p.members.push({id: p.nextMemberId++, genome: p.initialGenome(), fitness: 0, species: -1});
    }
    p.speciate();
    return p;
  }

  private innovationFor(from: number, to: number): number {
    const key = `${from}>${to}`;
    let innov = this.innovations.get(key);
    if (innov === undefined) {
      innov = this.nextInnov++;
      this.innovations.set(key, innov);
    }
    return innov;
  }

  private randomWeight(): number {
    return (this.rng.next() * 2 - 1) * this.config.weightRange;
  }

  private gaussian(): number {
    // Box–Muller with the seeded rng.
    const u = 1 - this.rng.next();
    const v = this.rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  initialGenome(): Genome {
    const nodes: NodeGene[] = [];
    for (let i = 0; i < INPUTS; i++) nodes.push({id: i, kind: 'input'});
    for (let o = 0; o < OUTPUTS; o++) nodes.push({id: INPUTS + o, kind: 'output'});
    const conns: ConnGene[] = [];
    for (let i = 0; i < INPUTS; i++) {
      for (let o = 0; o < OUTPUTS; o++) {
        conns.push({innov: this.innovationFor(i, INPUTS + o), from: i, to: INPUTS + o, w: this.randomWeight(), on: true});
      }
    }
    return {format: GENOME_FORMAT, nodes, conns};
  }

  distance(a: Genome, b: Genome): number {
    const {c1, c2, c3} = this.config;
    const ma = new Map(a.conns.map((c) => [c.innov, c]));
    const mb = new Map(b.conns.map((c) => [c.innov, c]));
    const maxA = a.conns.reduce((m, c) => Math.max(m, c.innov), -1);
    const maxB = b.conns.reduce((m, c) => Math.max(m, c.innov), -1);
    const cut = Math.min(maxA, maxB);
    let excess = 0;
    let disjoint = 0;
    let matching = 0;
    let wDiff = 0;
    for (const [innov, ca] of ma) {
      const cb = mb.get(innov);
      if (cb) {
        matching++;
        wDiff += Math.abs(ca.w - cb.w);
      } else if (innov > cut) {
        excess++;
      } else {
        disjoint++;
      }
    }
    for (const innov of mb.keys()) {
      if (!ma.has(innov)) {
        if (innov > cut) excess++;
        else disjoint++;
      }
    }
    const n = Math.max(a.conns.length, b.conns.length);
    const norm = n < 20 ? 1 : n;
    return (c1 * excess) / norm + (c2 * disjoint) / norm + c3 * (matching ? wDiff / matching : 0);
  }

  speciate(): void {
    for (const s of this.species) s.members = [];
    for (const m of this.members) {
      let home: Species | undefined;
      for (const s of this.species) {
        if (this.distance(m.genome, s.representative) < this.threshold) {
          home = s;
          break;
        }
      }
      if (!home) {
        home = {id: this.nextSpeciesId++, representative: m.genome, members: [], bestFitness: -Infinity, lastImproved: this.generation};
        this.species.push(home);
      }
      home.members.push(m);
      m.species = home.id;
    }
    this.species = this.species.filter((s) => s.members.length > 0);
    const [lo, hi] = this.config.targetSpecies;
    if (this.species.length < lo) this.threshold = Math.max(0.3, this.threshold - this.config.thresholdStep);
    else if (this.species.length > hi) this.threshold += this.config.thresholdStep;
  }

  /** Assign fitness to the current members (same order), then breed the next generation. */
  advance(fitness: number[]): void {
    if (fitness.length !== this.members.length) {
      throw new Error(`expected ${this.members.length} fitness values, got ${fitness.length}`);
    }
    this.members.forEach((m, i) => (m.fitness = fitness[i]!));

    for (const s of this.species) {
      const best = Math.max(...s.members.map((m) => m.fitness));
      if (best > s.bestFitness) {
        s.bestFitness = best;
        s.lastImproved = this.generation;
      }
    }
    // Stagnation cull, never removing the two best species.
    const ranked = [...this.species].sort((a, b) => b.bestFitness - a.bestFitness);
    const protectedIds = new Set(ranked.slice(0, 2).map((s) => s.id));
    let alive = this.species.filter(
        (s) => protectedIds.has(s.id) || this.generation - s.lastImproved < this.config.stagnation);
    if (alive.length === 0) alive = ranked.slice(0, 1);

    const shared = alive.map((s) => s.members.reduce((a, m) => a + Math.max(m.fitness, 0), 0) / s.members.length);
    const total = shared.reduce((a, b) => a + b, 0);
    const size = this.config.populationSize;
    let quotas = alive.map((_, i) => (total > 0 ? Math.floor((shared[i]! / total) * size) : Math.floor(size / alive.length)));
    // Hand out the rounding remainder to the best species first.
    let remaining = size - quotas.reduce((a, b) => a + b, 0);
    const order = alive.map((_, i) => i).sort((a, b) => shared[b]! - shared[a]!);
    for (let k = 0; remaining > 0; k = (k + 1) % order.length, remaining--) quotas[order[k]!]!++;

    const next: Member[] = [];
    alive.forEach((s, si) => {
      const sorted = [...s.members].sort((a, b) => b.fitness - a.fitness);
      const parents = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * this.config.survivalFraction)));
      let quota = quotas[si]!;
      if (quota > 0 && s.members.length > this.config.elitismMinSize) {
        next.push({id: this.nextMemberId++, genome: cloneGenome(sorted[0]!.genome), fitness: 0, species: -1});
        quota--;
      }
      for (let k = 0; k < quota; k++) {
        const p1 = this.pick(parents);
        let child: Genome;
        if (this.rng.next() < this.config.crossoverRate) {
          const other = this.rng.next() < this.config.interspeciesRate ?
              this.pick(this.pick(alive).members) :
              this.pick(parents);
          child = this.crossover(p1, other);
        } else {
          child = cloneGenome(p1.genome);
        }
        this.mutate(child);
        next.push({id: this.nextMemberId++, genome: child, fitness: 0, species: -1});
      }
    });
    this.species = alive.map((s) => ({...s, representative: this.pick(s.members).genome}));
    this.members = next;
    this.generation++;
    this.speciate();
  }

  private pick<T>(list: T[]): T {
    return list[Math.floor(this.rng.next() * list.length)]!;
  }

  crossover(a: Member, b: Member): Genome {
    const [fit, weak] = a.fitness >= b.fitness ? [a, b] : [b, a];
    const weakByInnov = new Map(weak.genome.conns.map((c) => [c.innov, c]));
    const conns: ConnGene[] = fit.genome.conns.map((c) => {
      const other = weakByInnov.get(c.innov);
      const src = other && this.rng.next() < 0.5 ? other : c;
      const on = !c.on || (other && !other.on) ? this.rng.next() > 0.75 : true;
      return {...src, on};
    });
    const nodeIds = new Set<number>();
    for (const n of fit.genome.nodes) nodeIds.add(n.id);
    const nodes = fit.genome.nodes.map((n) => ({...n}));
    const child = {format: GENOME_FORMAT, nodes, conns};
    return createsCycle(child) ? cloneGenome(fit.genome) : child;
  }

  mutate(g: Genome): void {
    const cfg = this.config;
    if (this.rng.next() < cfg.weightMutateRate) {
      for (const c of g.conns) {
        if (this.rng.next() < cfg.weightPerturbRate) {
          c.w += this.gaussian() * cfg.weightPerturbSigma;
          c.w = Math.max(-cfg.weightClamp, Math.min(cfg.weightClamp, c.w));
        } else {
          c.w = this.randomWeight();
        }
      }
    }
    if (this.rng.next() < cfg.addConnRate) this.addConnection(g);
    if (this.rng.next() < cfg.addNodeRate) this.addNode(g);
    if (g.conns.length && this.rng.next() < cfg.toggleRate) {
      const c = this.pick(g.conns);
      c.on = !c.on;
    }
  }

  addConnection(g: Genome): boolean {
    const sources = g.nodes.filter((n) => n.kind !== 'output');
    const targets = g.nodes.filter((n) => n.kind !== 'input');
    const existing = new Set(g.conns.map((c) => `${c.from}>${c.to}`));
    for (let attempt = 0; attempt < 20; attempt++) {
      const from = this.pick(sources).id;
      const to = this.pick(targets).id;
      if (from === to || existing.has(`${from}>${to}`) || reaches(g, to, from)) continue;
      g.conns.push({innov: this.innovationFor(from, to), from, to, w: this.randomWeight(), on: true});
      return true;
    }
    return false;
  }

  addNode(g: Genome): boolean {
    const enabled = g.conns.filter((c) => c.on);
    if (!enabled.length) return false;
    const c = this.pick(enabled);
    let id = this.splits.get(c.innov);
    if (id === undefined || g.nodes.some((n) => n.id === id)) {
      id = this.nextNodeId++;
      if (!this.splits.has(c.innov)) this.splits.set(c.innov, id);
    }
    c.on = false;
    g.nodes.push({id, kind: 'hidden'});
    g.conns.push({innov: this.innovationFor(c.from, id), from: c.from, to: id, w: 1, on: true});
    g.conns.push({innov: this.innovationFor(id, c.to), from: id, to: c.to, w: c.w, on: true});
    return true;
  }

  best(): Member {
    return this.members.reduce((a, b) => (b.fitness > a.fitness ? b : a));
  }

  toJSON(): PopulationState {
    return {
      generation: this.generation,
      rng: {state: this.rng.state, calls: this.rng.calls},
      nextMemberId: this.nextMemberId,
      nextNodeId: this.nextNodeId,
      nextInnov: this.nextInnov,
      innovations: [...this.innovations],
      splits: [...this.splits],
      threshold: this.threshold,
      members: this.members,
      species: this.species.map(({members, ...s}) => ({...s, memberIds: members.map((m) => m.id)})),
      nextSpeciesId: this.nextSpeciesId,
    };
  }

  static fromJSON(state: PopulationState, config: NeatConfig = DEFAULT_NEAT): Population {
    const p = new Population(0, config);
    p.generation = state.generation;
    p.rng.state = state.rng.state;
    p.rng.calls = state.rng.calls;
    p.nextMemberId = state.nextMemberId;
    p.nextNodeId = state.nextNodeId;
    p.nextInnov = state.nextInnov;
    for (const [k, v] of state.innovations) p.innovations.set(k, v);
    for (const [k, v] of state.splits) p.splits.set(k, v);
    p.threshold = state.threshold;
    p.members = state.members;
    const byId = new Map(p.members.map((m) => [m.id, m]));
    p.species = state.species.map(({memberIds, ...s}) => ({...s, members: memberIds.map((id) => byId.get(id)!).filter(Boolean)}));
    p.nextSpeciesId = state.nextSpeciesId;
    return p;
  }
}

export function cloneGenome(g: Genome): Genome {
  return {format: g.format, nodes: g.nodes.map((n) => ({...n})), conns: g.conns.map((c) => ({...c}))};
}

/** True if `from` can reach `to` through enabled-or-disabled connections. */
function reaches(g: Genome, from: number, to: number): boolean {
  const out = new Map<number, number[]>();
  for (const c of g.conns) {
    let l = out.get(c.from);
    if (!l) out.set(c.from, (l = []));
    l.push(c.to);
  }
  const stack = [from];
  const seen = new Set<number>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of out.get(n) ?? []) stack.push(m);
  }
  return false;
}

function createsCycle(g: Genome): boolean {
  try {
    new Network(g);
    return false;
  } catch {
    return true;
  }
}

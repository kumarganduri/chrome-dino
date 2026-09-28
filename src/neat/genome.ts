// NEAT genome + feed-forward network.
//
//   Genome = node genes + connection genes (innovation-numbered)
//     inputs  0..INPUTS-1   (sense vector, then a bias fixed at 1)
//     outputs INPUTS..INPUTS+OUTPUTS-1   → [jumpHeld, downHeld]
//     hidden  ids allocated by the innovation tracker
//
//   compile(genome) → Network: topologically ordered, disabled genes dropped.
//   Network.activate(senses) → outputs in [0,1] via the rational sigmoid
//     0.5 + 0.5·x/(1+|x|): only + − × ÷, so every JS engine agrees bit-for-bit.
import {SENSE_SIZE} from '../hook/sense.ts';

export const INPUTS = SENSE_SIZE + 1; // + bias
export const OUTPUTS = 2;
export const BIAS_ID = SENSE_SIZE;
export const GENOME_FORMAT = 1;

export type NodeKind = 'input' | 'output' | 'hidden';

export interface NodeGene {
  id: number;
  kind: NodeKind;
}

export interface ConnGene {
  innov: number;
  from: number;
  to: number;
  w: number;
  on: boolean;
}

export interface Genome {
  format: number;
  nodes: NodeGene[];
  conns: ConnGene[];
}

export function activation(x: number): number {
  return 0.5 + (0.5 * x) / (1 + (x < 0 ? -x : x));
}

export function isOutput(id: number): boolean {
  return id >= INPUTS && id < INPUTS + OUTPUTS;
}

export class Network {
  private readonly order: Int32Array; // node ids to evaluate, in order
  private readonly inStart: Int32Array; // per ordered node: slice into edges
  private readonly edgeFrom: Int32Array;
  private readonly edgeW: Float64Array;
  private readonly values: Float64Array;
  private readonly slot: Map<number, number>;
  private readonly inputSlots: Int32Array;
  private readonly outputSlots: Int32Array;
  readonly outputs = new Float64Array(OUTPUTS);

  constructor(genome: Genome) {
    const ids = genome.nodes.map((n) => n.id);
    this.slot = new Map(ids.map((id, i) => [id, i]));
    this.values = new Float64Array(ids.length);
    const incoming = new Map<number, ConnGene[]>();
    for (const c of genome.conns) {
      if (!c.on) continue;
      let list = incoming.get(c.to);
      if (!list) incoming.set(c.to, (list = []));
      list.push(c);
    }
    // Topological order over non-input nodes (Kahn). Cycles are impossible
    // by construction (mutations refuse them); a leftover means corrupt data.
    const indeg = new Map<number, number>();
    const outgoing = new Map<number, number[]>();
    for (const n of genome.nodes) indeg.set(n.id, 0);
    for (const [to, list] of incoming) {
      indeg.set(to, list.length);
      for (const c of list) {
        let o = outgoing.get(c.from);
        if (!o) outgoing.set(c.from, (o = []));
        o.push(to);
      }
    }
    const ready = genome.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    const order: number[] = [];
    while (ready.length) {
      const id = ready.shift()!;
      if (genome.nodes[this.slot.get(id)!]!.kind !== 'input') order.push(id);
      for (const to of outgoing.get(id) ?? []) {
        const d = indeg.get(to)! - 1;
        indeg.set(to, d);
        if (d === 0) ready.push(to);
      }
    }
    const nonInputs = genome.nodes.filter((n) => n.kind !== 'input').length;
    if (order.length !== nonInputs) {
      throw new Error('genome has a cycle');
    }
    this.order = new Int32Array(order.map((id) => this.slot.get(id)!));
    const starts: number[] = [];
    const from: number[] = [];
    const w: number[] = [];
    for (const id of order) {
      starts.push(from.length);
      for (const c of incoming.get(id) ?? []) {
        from.push(this.slot.get(c.from)!);
        w.push(c.w);
      }
    }
    starts.push(from.length);
    this.inStart = new Int32Array(starts);
    this.inputSlots = new Int32Array(Array.from({length: INPUTS}, (_, i) => this.slot.get(i)!));
    this.outputSlots = new Int32Array(Array.from({length: OUTPUTS}, (_, i) => this.slot.get(INPUTS + i)!));
    this.edgeFrom = new Int32Array(from);
    this.edgeW = new Float64Array(w);
  }

  activate(senses: ArrayLike<number>): Float64Array {
    const v = this.values;
    for (let i = 0; i < SENSE_SIZE; i++) v[this.inputSlots[i]!] = senses[i]!;
    v[this.inputSlots[BIAS_ID]!] = 1;
    for (let k = 0; k < this.order.length; k++) {
      let sum = 0;
      for (let e = this.inStart[k]!; e < this.inStart[k + 1]!; e++) {
        sum += v[this.edgeFrom[e]!]! * this.edgeW[e]!;
      }
      v[this.order[k]!] = activation(sum);
    }
    for (let o = 0; o < OUTPUTS; o++) this.outputs[o] = v[this.outputSlots[o]!]!;
    return this.outputs;
  }

  /** Node activations of the last activate() call, keyed by node id (for the brain view). */
  valueOf(id: number): number {
    return this.values[this.slot.get(id)!]!;
  }
}

export function validateGenome(g: unknown): Genome {
  const x = g as Genome;
  if (!x || typeof x !== 'object' || x.format !== GENOME_FORMAT || !Array.isArray(x.nodes) || !Array.isArray(x.conns)) {
    throw new Error(`invalid genome (expected format ${GENOME_FORMAT})`);
  }
  const ids = new Set(x.nodes.map((n) => n.id));
  for (let i = 0; i < INPUTS + OUTPUTS; i++) {
    if (!ids.has(i)) throw new Error(`invalid genome: missing node ${i}`);
  }
  for (const c of x.conns) {
    if (!ids.has(c.from) || !ids.has(c.to) || !Number.isFinite(c.w)) {
      throw new Error(`invalid genome: bad connection ${c.innov}`);
    }
  }
  new Network(x); // throws on cycles
  return x;
}

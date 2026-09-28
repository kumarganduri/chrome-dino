import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activation, INPUTS, Network, OUTPUTS, validateGenome, type Genome} from '../src/neat/genome.ts';
import {Population, cloneGenome, DEFAULT_NEAT} from '../src/neat/population.ts';
import {SENSE_SIZE} from '../src/hook/sense.ts';

const senses = Float64Array.from({length: SENSE_SIZE}, (_, i) => (i % 5) / 5);

test('rational sigmoid: range, midpoint, monotone, exact values', () => {
  assert.equal(activation(0), 0.5);
  assert.equal(activation(1), 0.75);
  assert.equal(activation(-1), 0.25);
  assert.ok(activation(1e9) < 1 && activation(-1e9) > 0);
  for (let x = -5; x < 5; x += 0.25) assert.ok(activation(x + 0.25) > activation(x));
});

test('initial genome is fully connected inputs→outputs and activates', () => {
  const p = Population.create(1);
  const g = p.members[0]!.genome;
  assert.equal(g.nodes.length, INPUTS + OUTPUTS);
  assert.equal(g.conns.length, INPUTS * OUTPUTS);
  const out = new Network(g).activate(senses);
  assert.equal(out.length, 2);
  for (const v of out) assert.ok(v > 0 && v < 1);
});

test('same seed → identical population; different seed → different', () => {
  const a = JSON.stringify(Population.create(7).members);
  const b = JSON.stringify(Population.create(7).members);
  const c = JSON.stringify(Population.create(8).members);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('add-node and add-connection never create cycles; innovations reused', () => {
  const p = Population.create(3);
  for (let i = 0; i < 300; i++) {
    const g = p.members[i % p.members.length]!.genome;
    p.addNode(g);
    p.addConnection(g);
    p.addConnection(g);
    new Network(g); // throws on a cycle
  }
  // The same structural mutation in two genomes shares the innovation number.
  const g1 = p.initialGenome();
  const g2 = p.initialGenome();
  g1.conns[0]!.on = true;
  p.addNode(g1);
  p.addNode(g2);
  const newInnov = (g: Genome) => g.conns.slice(-2).map((c) => c.innov);
  if (g1.conns.at(-2)!.from === g2.conns.at(-2)!.from && g1.conns.at(-1)!.to === g2.conns.at(-1)!.to) {
    assert.deepEqual(newInnov(g1), newInnov(g2));
  }
});

test('split node keeps the function (weight 1 in, old weight out) and disables the old gene', () => {
  const p = Population.create(4);
  const g = cloneGenome(p.members[0]!.genome);
  const before = g.conns.filter((c) => c.on).length;
  p.addNode(g);
  assert.equal(g.conns.filter((c) => c.on).length, before + 1);
  assert.equal(g.conns.filter((c) => !c.on).length, 1);
  assert.equal(g.conns.at(-2)!.w, 1);
});

test('distance: identical genomes 0; grows with structural difference', () => {
  const p = Population.create(5);
  const g = p.members[0]!.genome;
  assert.equal(p.distance(g, cloneGenome(g)), 0);
  const h = cloneGenome(g);
  for (let i = 0; i < 5; i++) p.addNode(h);
  assert.ok(p.distance(g, h) > 0);
});

test('evolution on XOR-like toy task improves and keeps population size', () => {
  const p = Population.create(11, {...DEFAULT_NEAT, populationSize: 100});
  const cases = [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]];
  const score = (g: Genome) => {
    const n = new Network(g);
    let err = 0;
    for (const [a, b, want] of cases) {
      const s = new Float64Array(SENSE_SIZE);
      s[0] = a!;
      s[1] = b!;
      err += Math.abs(n.activate(s)[0]! - want!);
    }
    return 4 - err;
  };
  const first = Math.max(...p.members.map((m) => score(m.genome)));
  let best = first;
  for (let gen = 0; gen < 60; gen++) {
    const fit = p.members.map((m) => score(m.genome));
    best = Math.max(best, ...fit);
    p.advance(fit);
    assert.equal(p.members.length, 100);
  }
  assert.ok(best > first, `no improvement ${first} → ${best}`);
  assert.ok(p.species.length >= 1);
});

test('population JSON round-trip continues identically', () => {
  const a = Population.create(21, {...DEFAULT_NEAT, populationSize: 40});
  const fit = (p: Population) => p.members.map((m) => m.genome.conns.reduce((s, c) => s + c.w, 0));
  a.advance(fit(a));
  const b = Population.fromJSON(JSON.parse(JSON.stringify(a.toJSON())), {...DEFAULT_NEAT, populationSize: 40});
  a.advance(fit(a));
  b.advance(fit(b));
  assert.equal(JSON.stringify(a.members), JSON.stringify(b.members));
});

test('validateGenome rejects corrupt, old-format and cyclic genomes', () => {
  const g = Population.create(2).members[0]!.genome;
  assert.doesNotThrow(() => validateGenome(JSON.parse(JSON.stringify(g))));
  assert.throws(() => validateGenome({...g, format: 0}), /format/);
  assert.throws(() => validateGenome({...g, nodes: g.nodes.slice(1)}), /missing node/);
  assert.throws(() => validateGenome(null), /invalid genome/);
  const cyc = cloneGenome(g);
  cyc.nodes.push({id: 500, kind: 'hidden'}, {id: 501, kind: 'hidden'});
  cyc.conns.push({innov: 900, from: 500, to: 501, w: 1, on: true}, {innov: 901, from: 501, to: 500, w: 1, on: true});
  assert.throws(() => validateGenome(cyc), /cycle/);
});

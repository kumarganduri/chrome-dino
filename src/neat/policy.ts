// Brain → keys. One function, used by training, the page, the server and the
// chrome://dino driver: sense the game, run the network, hold a key when its
// output is above 0.5.
import {sense, SENSE_SIZE, type SenseSource} from '../hook/sense.ts';
import type {Keys} from '../hook/act.ts';
import type {Network} from './genome.ts';

export class BrainPolicy {
  readonly net: Network;
  readonly senses = new Float64Array(SENSE_SIZE);

  constructor(net: Network) {
    this.net = net;
  }

  keys(runner: SenseSource): Keys {
    const out = this.net.activate(sense(runner, this.senses));
    return {jump: out[0]! > 0.5, down: out[1]! > 0.5};
  }
}

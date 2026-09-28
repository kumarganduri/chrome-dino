// Pins every environment input the vendored game reads, so a run depends only
// on (seed, actions).
//
//   read once at bundle load (constants.ts): navigator.userAgent, devicePixelRatio,
//                                             document.documentElement.dir
//   read every step: Math.random (utils/horizon/obstacle/trex/cloud/night mode)
//                    performance.now via getTimeStamp()
//                    requestAnimationFrame via Runner.scheduleNextUpdate()
//
// installNodeEnv() runs before dist/engine.mjs is imported. withGameGlobals()
// swaps Math.random and performance.now only for the duration of one step, so
// code outside the game (NEAT, UI, tests) keeps the real ones.
import type {Rng} from './rng.ts';

export const PINNED_USER_AGENT = 'Mozilla/5.0 (dino-forever) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';

let installed = false;

export function installNodeEnv(): void {
  if (installed) {
    return;
  }
  installed = true;
  const g = globalThis as any;
  const classList = {toggle: (_c: string, force?: boolean) => !!force, add() {}, remove() {}, contains: () => false};
  const element = () => ({
    style: {}, classList, setAttribute() {}, appendChild() {}, addEventListener() {},
    getBoundingClientRect: () => ({top: 0}), textContent: '', className: '',
  });
  g.window = g;
  Object.defineProperty(g, 'navigator', {value: {userAgent: PINNED_USER_AGENT, vibrate: () => false}, configurable: true});
  g.devicePixelRatio = 1;
  g.document = {
    documentElement: {dir: ''},
    firstElementChild: {classList},
    querySelector: () => element(),
    getElementById: () => element(),
    createElement: () => element(),
    addEventListener() {},
    styleSheets: [{insertRule() {}}],
    title: '',
  };
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  g.matchMedia = () => ({matches: false, addListener() {}});
}

export interface GameClock {
  now: number;
}

export function withGameGlobals<T>(rng: Rng, clock: GameClock, fn: () => T): T {
  const realRandom = Math.random;
  const realNow = performance.now;
  Math.random = rng.next;
  performance.now = () => clock.now;
  try {
    return fn();
  } finally {
    Math.random = realRandom;
    performance.now = realNow;
  }
}

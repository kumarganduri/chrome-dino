// Injected into the real chrome://dino page by scripts/real-chrome.mjs.
// Uses the same sense + network code as everything else, reads Chrome's own
// Runner instance, and presses keys with real KeyboardEvents (keyCode 32 =
// jump, 40 = duck), exactly like a player. Real time, real rAF: live only,
// never replayable.
import {Network, validateGenome} from '../neat/genome.ts';
import {BrainPolicy} from '../neat/policy.ts';

// chrome://dino declares `class Runner` in a classic script: a global lexical
// binding, not a window property, so it is referenced by name.
declare const Runner: {getInstance(): any};

interface Stats {
  runs: number;
  crashes: number;
  best: number;
  current: number;
  running: boolean;
  error?: string;
}

export function start(genomeJson: unknown): Stats {
  const policy = new BrainPolicy(new Network(validateGenome(genomeJson)));
  const stats: Stats = {runs: 0, crashes: 0, best: 0, current: 0, running: true};
  const held = {jump: false, down: false};
  const press = (key: 'jump' | 'down', down: boolean) => {
    if (held[key] === down && !(down && key === 'jump')) return;
    held[key] = down;
    const keyCode = key === 'jump' ? 32 : 40;
    document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {keyCode, bubbles: true} as KeyboardEventInit));
  };
  let crashedAt = 0;
  const loop = () => {
    try {
      tick();
    } catch (e) {
      stats.error = String((e as Error)?.stack ?? e);
    }
    requestAnimationFrame(loop);
  };
  const tick = () => {
    const r = Runner.getInstance();
    if (r && r.tRex && r.horizon) {
      if (r.crashed) {
        if (!crashedAt) {
          crashedAt = performance.now();
          stats.crashes++;
          press('jump', false);
          press('down', false);
        } else if (performance.now() - crashedAt > 1500) {
          crashedAt = 0;
          stats.runs++;
          press('jump', true); // restart, like pressing space on the game-over screen
          press('jump', false);
        }
      } else {
        const k = policy.keys(r);
        press('jump', k.jump);
        press('down', k.down);
        stats.current = Math.round(r.distanceMeter.getActualDistance(Math.ceil(r.distanceRan)));
        stats.best = Math.max(stats.best, stats.current);
      }
    }
  };
  stats.runs = 1;
  press('jump', true); // first press starts the game
  press('jump', false);
  requestAnimationFrame(loop);
  (window as any).__dinoForever = stats;
  return stats;
}

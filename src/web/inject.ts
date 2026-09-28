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
    // A held key re-fires keydown every frame (auto-repeat), exactly like
    // src/hook/act.ts in training; for DUCK in the air that re-applies
    // Chrome's setSpeedDrop() each frame. Release fires keyup once.
    if (held[key] === down && !down) return;
    held[key] = down;
    const keyCode = key === 'jump' ? 32 : 40;
    document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {keyCode, bubbles: true} as KeyboardEventInit));
  };
  let crashedAt = 0;
  // Decide inside Chrome's own frame, right before Runner.update, the same
  // order as training (keys, then update). Runner schedules
  // requestAnimationFrame(this.update.bind(this)), which picks up this
  // per-instance wrapper.
  const r = Runner.getInstance();
  const originalUpdate = r.update;
  r.update = function(this: any, ...args: unknown[]) {
    try {
      decide(this);
    } catch (e) {
      stats.error = String((e as Error)?.stack ?? e);
    }
    return originalUpdate.apply(this, args);
  };
  const decide = (runner: any) => {
    if (!runner.tRex || !runner.horizon || runner.crashed || !runner.playing) return;
    const k = policy.keys(runner);
    press('jump', k.jump);
    press('down', k.down);
    stats.current = Math.round(runner.distanceMeter.getActualDistance(Math.ceil(runner.distanceRan)));
    stats.best = Math.max(stats.best, stats.current);
  };
  // Restarts after a crash (the game loop stops while crashed).
  const watch = () => {
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
    }
    requestAnimationFrame(watch);
  };
  stats.runs = 1;
  press('jump', true); // first press starts the game
  press('jump', false);
  requestAnimationFrame(watch);
  (window as any).__dinoForever = stats;
  return stats;
}

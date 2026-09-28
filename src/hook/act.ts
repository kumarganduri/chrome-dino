// Turns "which keys are held this frame" into the exact calls Chromium's
// Runner.onKeyDown / onKeyUp make for the jump and duck keys
// (vendor/chromium-dino/dino_game/offline.ts:1064-1166). A held key re-fires
// keydown every frame, like keyboard auto-repeat; release fires keyup once.
//
//   jump held    → keydown(jump): startJump(speed) if on the ground and not ducking
//   jump release → keyup(jump):   endJump() (short hop if released early)
//   down held    → keydown(duck): airborne → setSpeedDrop(); grounded → setDuck(true)
//   down release → keyup(duck):   speedDrop = false; setDuck(false)
//
// Shared by the headless game, the browser champion, the swarm and the
// injected chrome://dino driver, so every place presses keys identically.
export interface Keys {
  jump: boolean;
  down: boolean;
}

export const NO_KEYS: Keys = Object.freeze({jump: false, down: false});

interface TrexLike {
  jumping: boolean;
  ducking: boolean;
  speedDrop: boolean;
  startJump(speed: number): void;
  endJump(): void;
  setSpeedDrop(): void;
  setDuck(ducking: boolean): void;
}

interface RunnerLike {
  tRex: TrexLike;
  currentSpeed: number;
  playing: boolean;
  crashed: boolean;
  paused: boolean;
  raqId: number;
}

export function applyKeys(runner: RunnerLike, prev: Keys, next: Keys): void {
  const tRex = runner.tRex;
  const accepting = !runner.crashed && !runner.paused;

  // Separate events per key, jump first, as two held keys would dispatch.
  if (accepting && next.jump && !tRex.jumping && !tRex.ducking) {
    tRex.startJump(runner.currentSpeed);
  }
  if (accepting && runner.playing && next.down) {
    if (tRex.jumping) {
      tRex.setSpeedDrop();
    } else if (!tRex.ducking) {
      tRex.setDuck(true);
    }
  }

  if (prev.jump && !next.jump && runner.raqId) {
    tRex.endJump();
  }
  if (prev.down && !next.down) {
    tRex.speedDrop = false;
    tRex.setDuck(false);
  }
}

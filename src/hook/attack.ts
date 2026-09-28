// Attack drops: a visitor chooses what Chrome's obstacle generator spawns
// next. The drop replaces the generator's random pick at the exact moment
// Chrome itself would spawn (Horizon.updateObstacles → addNewObstacle), so
// gaps stay Chrome's, and the vendored Obstacle constructor still rolls size
// and gap. Only obstacle type (and pterodactyl height) are chosen.
//
// Legal only if Chrome could have picked it right now:
//   speed ≥ type.minSpeed          (pterodactyls from 8.5)
//   !duplicateObstacleCheck(type)  (no third identical obstacle in a row)
//   pterodactyl yPos ∈ {100, 75, 50}
//
// The queue lives on the Horizon instance as plain data, so it is part of
// snapshots and replays exactly. Games without a queue run Chrome's
// addNewObstacle unchanged.
export type DropType = 'cactusSmall' | 'cactusLarge' | 'pterodactyl';

export interface Drop {
  type: DropType;
  yPos?: 100 | 75 | 50;
}

export interface DropOutcome {
  frame: number;
  drop: Drop;
  accepted: boolean;
  reason?: string;
}

let installed = false;

export function installAttackHook(engine: any): void {
  if (installed) return;
  installed = true;
  const proto = engine.Horizon.prototype;
  const original = proto.addNewObstacle;
  proto.addNewObstacle = function(this: any, currentSpeed: number) {
    const queue: Drop[] | undefined = this.attackQueue;
    if (!queue || queue.length === 0) {
      return original.call(this, currentSpeed);
    }
    const drop = queue.shift()!;
    const typeConfig = this.obstacleTypes.find((t: any) => t.type === drop.type);
    const reason = illegalReason(this, typeConfig, drop, currentSpeed);
    if (reason) {
      (this.attackLog ??= []).push({drop, accepted: false, reason});
      return original.call(this, currentSpeed);
    }
    const o = new engine.Obstacle(
        this.canvasCtx, typeConfig, this.spritePos[typeConfig.type], this.dimensions,
        this.gapCoefficient, currentSpeed, typeConfig.width, this.resourceProvider, this.altGameModeActive);
    if (drop.type === 'pterodactyl' && drop.yPos !== undefined) {
      o.yPos = drop.yPos;
    }
    this.obstacles.push(o);
    this.obstacleHistory.unshift(typeConfig.type);
    if (this.obstacleHistory.length > 1) {
      this.obstacleHistory.splice(this.resourceProvider.getConfig().maxObstacleDuplication);
    }
    (this.attackLog ??= []).push({drop, accepted: true});
  };
}

function illegalReason(horizon: any, typeConfig: any, drop: Drop, speed: number): string | null {
  if (!typeConfig) return `unknown obstacle ${drop.type}`;
  if (speed < typeConfig.minSpeed) return `${drop.type} appears only from speed ${typeConfig.minSpeed}`;
  if (horizon.duplicateObstacleCheck(typeConfig.type)) return `Chrome never spawns 3 ${drop.type} in a row`;
  if (drop.type === 'pterodactyl' && drop.yPos !== undefined && ![100, 75, 50].includes(drop.yPos)) {
    return `pterodactyls fly at 100, 75 or 50`;
  }
  return null;
}

/** Queue a drop for the next spawn. Returns false if one is already queued. */
export function queueDrop(game: {runner: any}, drop: Drop): boolean {
  const h = game.runner.horizon;
  h.attackQueue ??= [];
  if (h.attackQueue.length >= 1) return false;
  h.attackQueue.push(drop);
  return true;
}

export function dropCheck(game: {runner: any}, drop: Drop): string | null {
  const h = game.runner.horizon;
  return illegalReason(h, h.obstacleTypes.find((t: any) => t.type === drop.type), drop, game.runner.currentSpeed);
}

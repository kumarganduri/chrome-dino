// Hand-written controller: the yardstick for "is running forever possible?".
// Never shown as the player; the page only ever runs trained NEAT brains.
//
// Rules, per frame, looking at the first obstacle not yet passed:
//   high pterodactyl (yPos 50)  → run under it
//   mid pterodactyl (yPos 75)   → duck while it is close
//   anything else               → jump when dx < jumpAt(speed)
//   airborne and past the obstacle → optionally hold down (fast-fall) until landing
import type {Keys} from '../hook/act.ts';

export interface OracleParams {
  jumpBase: number; // px before the obstacle at speed 0
  jumpPerSpeed: number; // extra px per unit of speed
  duckWindow: number; // px ahead to start ducking under mid pterodactyls
  fastFall: boolean; // hold down after clearing an obstacle
}

export const DEFAULT_ORACLE: OracleParams = {jumpBase: 10, jumpPerSpeed: 12, duckWindow: 80, fastFall: false};

export function oracleKeys(r: any, p: OracleParams = DEFAULT_ORACLE): Keys {
  const t = r.tRex;
  const front = t.xPos + t.config.width;
  let next: any = null;
  for (const o of r.horizon.obstacles) {
    if (o.xPos + o.width > t.xPos) {
      next = o;
      break;
    }
  }
  if (t.jumping) {
    // Fast-fall only after clearing the obstacle, and once started keep the
    // key held until landing: releasing it resets Chrome's speedDrop.
    if (!p.fastFall) {
      return {jump: false, down: false};
    }
    const behind = !next || next.xPos - front > p.jumpBase + p.jumpPerSpeed * r.currentSpeed + 40;
    return {jump: false, down: t.speedDrop || (behind && t.jumpVelocity > -2)};
  }
  if (!next) {
    return {jump: false, down: false};
  }
  const dx = next.xPos - front;
  const isPtero = next.typeConfig.type === 'pterodactyl';
  if (isPtero && next.yPos <= 50) {
    return {jump: false, down: false};
  }
  if (isPtero && next.yPos === 75) {
    return {jump: false, down: dx < p.duckWindow};
  }
  return {jump: dx < p.jumpBase + p.jumpPerSpeed * r.currentSpeed, down: false};
}

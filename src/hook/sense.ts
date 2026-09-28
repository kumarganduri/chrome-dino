// What the dino "sees": a fixed-length vector of normalized numbers read from
// Chrome's game objects. The same function feeds NEAT in the trainer, the
// swarm, the visible champion, the server and the chrome://dino driver.
//
//   [0..7]   next obstacle   dx/600, time-to-contact (s), width/100, yPos/150,
//                            small, large, ptero, gap/600
//   [8..15]  second obstacle (same layout); absent → dx=1, ttc=2, rest 0
//   [16]     dino height above ground / 150
//   [17]     dino vertical velocity / 10
//   [18]     ducking (0/1)
//   [19]     speed / maxSpeed
//
// Time-to-contact = frames until the obstacle reaches the dino's front
// (obstacles move floor(speed) px per frame), in seconds, capped at 2. It is
// the quantity jump timing actually depends on at every speed.
export const SENSE_SIZE = 20;
const OBSTACLE_FIELDS = 8;
const TTC_CAP = 2;

interface ObstacleLike {
  xPos: number;
  width: number;
  yPos: number;
  gap: number;
  typeConfig: {type: string};
}

export interface SenseSource {
  currentSpeed: number;
  config: {maxSpeed: number};
  tRex: {xPos: number; yPos: number; groundYPos: number; jumpVelocity: number; ducking: boolean; config: {width: number}};
  horizon: {obstacles: ObstacleLike[]};
}

export function sense(r: SenseSource, out: Float64Array = new Float64Array(SENSE_SIZE)): Float64Array {
  const t = r.tRex;
  const front = t.xPos + t.config.width;
  let slot = 0;
  for (const o of r.horizon.obstacles) {
    if (slot === 2) {
      break;
    }
    if (o.xPos + o.width <= t.xPos) {
      continue; // already passed
    }
    const base = slot * OBSTACLE_FIELDS;
    const type = o.typeConfig.type;
    const dx = o.xPos - front;
    const pxPerFrame = Math.max(1, Math.floor(r.currentSpeed));
    out[base] = dx / 600;
    out[base + 1] = Math.min(TTC_CAP, dx / pxPerFrame / 60);
    out[base + 2] = o.width / 100;
    out[base + 3] = o.yPos / 150;
    out[base + 4] = type === 'cactusSmall' ? 1 : 0;
    out[base + 5] = type === 'cactusLarge' ? 1 : 0;
    out[base + 6] = type === 'pterodactyl' ? 1 : 0;
    out[base + 7] = o.gap / 600;
    slot++;
  }
  for (; slot < 2; slot++) {
    const base = slot * OBSTACLE_FIELDS;
    out[base] = 1;
    out[base + 1] = TTC_CAP;
    for (let i = 2; i < OBSTACLE_FIELDS; i++) {
      out[base + i] = 0;
    }
  }
  out[16] = (t.groundYPos - t.yPos) / 150;
  out[17] = t.jumpVelocity / 10;
  out[18] = t.ducking ? 1 : 0;
  out[19] = r.currentSpeed / r.config.maxSpeed;
  return out;
}

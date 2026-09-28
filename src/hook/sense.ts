// What the dino "sees": a fixed-length vector of normalized numbers read from
// Chrome's game objects. The same function feeds NEAT in the trainer, the
// swarm, the visible champion, the server and the chrome://dino driver.
//
//   [0..6]   next obstacle   dx/600, width/100, yPos/150, small, large, ptero, gap/600
//   [7..13]  second obstacle (same layout); absent → dx=1, rest 0
//   [14]     dino height above ground / 150
//   [15]     dino vertical velocity / 10
//   [16]     ducking (0/1)
//   [17]     speed / maxSpeed
export const SENSE_SIZE = 18;
const OBSTACLE_FIELDS = 7;

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
    out[base] = (o.xPos - front) / 600;
    out[base + 1] = o.width / 100;
    out[base + 2] = o.yPos / 150;
    out[base + 3] = type === 'cactusSmall' ? 1 : 0;
    out[base + 4] = type === 'cactusLarge' ? 1 : 0;
    out[base + 5] = type === 'pterodactyl' ? 1 : 0;
    out[base + 6] = o.gap / 600;
    slot++;
  }
  for (; slot < 2; slot++) {
    const base = slot * OBSTACLE_FIELDS;
    out[base] = 1;
    for (let i = 1; i < OBSTACLE_FIELDS; i++) {
      out[base + i] = 0;
    }
  }
  out[14] = (t.groundYPos - t.yPos) / 150;
  out[15] = t.jumpVelocity / 10;
  out[16] = t.ducking ? 1 : 0;
  out[17] = r.currentSpeed / r.config.maxSpeed;
  return out;
}

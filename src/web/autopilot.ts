// The "autopilot": pasted into DevTools on a visitor's own chrome://dino, it
// lets the published champion play their real Chrome dino. Built by
// build.mjs into public/autopilot.js (one self-contained script, the
// champion's brain included). Same driver as the live stream (inject.ts).
import {start} from './inject.ts';
import champion from '../../web/data/champion.json' with {type: 'json'};

declare const Runner: unknown;

(() => {
  if (typeof Runner === 'undefined') {
    console.warn('dino.forever autopilot: open chrome://dino in this tab first, then paste again.');
    return;
  }
  const stats = start((champion as {genome: unknown}).genome);
  console.log(`%cdino.forever autopilot: champion v${(champion as {version?: number}).version ?? '?'} is playing. ` +
    'Watch the game; window.__dinoForever has live stats and run history.', 'color:#188038;font-weight:600');
  (window as unknown as {__dinoForever: typeof stats}).__dinoForever = stats;
})();

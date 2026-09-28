// Plays the literal chrome://dino in your installed Google Chrome with the
// trained champion. A throwaway profile is used; your own Chrome profile is
// never touched.
//
//   node scripts/real-chrome.mjs [--headless] [--seconds 120] [--genome web/data/champion.json]
//
// This is live, real-time play (Chrome's real clock and randomness), so it is
// a demo, not a replay: the published results come from the deterministic
// engine that runs the same unedited Chromium code.
import {chromium} from 'playwright';
import {readFileSync, existsSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';

const {values: args} = parseArgs({options: {
  headless: {type: 'boolean', default: false},
  seconds: {type: 'string', default: '0'},
  genome: {type: 'string', default: ''},
}});
execFileSync(process.execPath, ['build.mjs'], {stdio: 'ignore'});
const pick = args.genome || ['web/data/champion.json', 'web/data/leader.json'].find((f) => {
  if (!existsSync(f)) return false;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  return j && j.genome;
});
if (!pick) throw new Error('no trained genome found (run the trainer and trainer/publish.ts first)');
const data = JSON.parse(readFileSync(pick, 'utf8'));
const inject = readFileSync('dist/inject.js', 'utf8');
console.log(`playing chrome://dino with ${pick} (${data.version ? `champion v${data.version}` : `gen ${data.gen}`})`);

const browser = await chromium.launch({channel: 'chrome', headless: args.headless, args: ['--window-size=900,500']});
const page = await browser.newPage({viewport: {width: 880, height: 420}});
// chrome://dino "fails" into chrome-error://chromewebdata, the page that hosts the game.
await page.goto('chrome://dino').catch(() => {});
await page.waitForLoadState('load').catch(() => {});
// Playwright evaluates error pages in an isolated world; Chrome's Runner lives
// in the main world, which raw CDP Runtime.evaluate reaches.
const cdp = await page.context().newCDPSession(page);
const run = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
for (let i = 0; i < 50 && (await run('typeof Runner')) !== 'function'; i++) await new Promise((r) => setTimeout(r, 200));
await run(`${inject};\nDinoForever.start(${JSON.stringify(data.genome)}); true`);
const started = Date.now();
const limit = Number(args.seconds) * 1000;
const timer = setInterval(async () => {
  try {
    const s = await run('window.__dinoForever');
    if (s.error) console.error(`\ninjected driver error: ${s.error}`);
    process.stdout.write(`\rscore ${String(s.current).padStart(6)} · best ${s.best} · crashes ${s.crashes} · runs ${s.runs}   `);
    if (limit && Date.now() - started > limit) {
      clearInterval(timer);
      console.log(`\n${JSON.stringify(s)}`);
      await browser.close();
    }
  } catch {
    clearInterval(timer);
  }
}, 1000);

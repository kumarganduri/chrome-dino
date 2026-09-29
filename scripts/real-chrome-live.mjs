// Plays the literal chrome://dino in a visible Google Chrome window with the
// champion, keeps it running (auto-restart after a crash), and streams the
// tab live: Chrome's own screencast of the tab (JPEG frames) plus stats, as
// server-sent events that the published page shows in its "Literal
// chrome://dino" panel.
//
//   node scripts/real-chrome-live.mjs [--port 8090] [--fps 10] [--headless]
//
//   GET /stream  → SSE: event "frame" {jpeg: base64}, event "stats" {…}
//   GET /status  → JSON stats
//   GET /frame.jpg → latest frame (polling fallback for strict proxies)
//
// Real clock + real randomness: this run cannot be recomputed elsewhere, so it
// is streamed, not shared as a seed. Runs log to out/real-chrome-live.jsonl.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';

const {values: args} = parseArgs({options: {
  port: {type: 'string', default: '8090'},
  fps: {type: 'string', default: '10'},
  headless: {type: 'boolean', default: false},
  genome: {type: 'string', default: 'web/data/champion.json'},
}});
const ALLOWED = ['https://kumarganduri14.gitlab.io', 'http://127.0.0.1:4173', 'http://localhost:4173'];
execFileSync(process.execPath, ['build.mjs'], {stdio: 'ignore'});
const data = JSON.parse(readFileSync(args.genome, 'utf8'));
if (!data?.genome) throw new Error(`no genome in ${args.genome}`);
const inject = readFileSync('dist/inject.js', 'utf8');
mkdirSync('out', {recursive: true});
const log = (event) => appendFileSync('out/real-chrome-live.jsonl', JSON.stringify({t: new Date().toISOString(), ...event}) + '\n');

// ── Chrome ────────────────────────────────────────────────────────────────
// Background/occlusion throttling off, so the game never pauses when the
// window is covered or the screen is locked.
const browser = await chromium.launch({
  channel: 'chrome',
  headless: args.headless,
  args: ['--window-size=760,420', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({viewport: {width: 740, height: 300}});
await page.goto('chrome://dino').catch(() => {}); // Chrome's offline page hosts the game
await page.waitForLoadState('load').catch(() => {});
const cdp = await page.context().newCDPSession(page);
const run = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
for (let i = 0; i < 50 && (await run('typeof Runner')) !== 'function'; i++) await new Promise((r) => setTimeout(r, 200));
const chromeVersion = await run('navigator.userAgent.match(/Chrome\\/[\\d.]+/)?.[0] ?? "Chrome"');
await run(`${inject};\nDinoForever.start(${JSON.stringify(data.genome)}); true`);
const startedAt = Date.now();
let runStartedAt = startedAt;
let lastCrashes = 0;
log({event: 'start', chrome: chromeVersion, champion: data.version ?? null});

// ── Stream ────────────────────────────────────────────────────────────────
const clients = new Set();
let latestFrame = null;
let latestStats = null;
const send = (res, type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);

const minGap = 1000 / Number(args.fps);
let lastSent = 0;
cdp.on('Page.screencastFrame', async ({data: jpeg, sessionId}) => {
  cdp.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
  const now = Date.now();
  if (now - lastSent < minGap) return;
  lastSent = now;
  latestFrame = jpeg;
  for (const res of clients) send(res, 'frame', {jpeg});
});
await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 70, maxWidth: 740, maxHeight: 300, everyNthFrame: 1});

// ── Record history (persists across restarts of this script) ──────────────
// Every finished run: start, end, duration, score, what ended it. The record
// is the highest score of any run, including the one in progress.
const HISTORY_FILE = 'out/real-chrome-live-history.json';
const history = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : [];
const saveHistory = () => writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 1));
let recorded = 0; // how many of this session's driver runs are already in `history`
const withMeta = (r) => ({...r, chrome: chromeVersion, champion: data.version ?? null});

let s = null;
setInterval(async () => {
  try {
    s = await run('window.__dinoForever');
  } catch (e) {
    log({event: 'error', error: String(e)});
    return;
  }
  while (recorded < s.history.length) {
    const r = withMeta(s.history[recorded++]);
    history.push(r);
    saveHistory();
    log({event: 'crash', ...r});
  }
  if (s.crashes > lastCrashes) lastCrashes = s.crashes;
  runStartedAt = s.runStartedAt;
  const current = {startedAt: s.runStartedAt, score: s.current, ongoing: true};
  const record = [...history, current].reduce((a, b) => (b.score > a.score ? b : a), current);
  latestStats = {
    chrome: chromeVersion, champion: data.version ?? null,
    streamingSince: startedAt, runStartedAt, now: Date.now(),
    score: s.current, best: s.best, crashes: s.crashes, runs: s.runs, error: s.error ?? null,
    record, totalRuns: history.length + 1, recent: history.slice(-8).reverse(),
  };
  for (const res of clients) send(res, 'stats', latestStats);
}, 1000);

createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) res.setHeader('access-control-allow-origin', origin);
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/stream') {
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive'});
    res.write('retry: 3000\n\n');
    if (latestStats) send(res, 'stats', latestStats);
    if (latestFrame) send(res, 'frame', {jpeg: latestFrame});
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/status') {
    res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
    res.end(JSON.stringify({...latestStats, viewers: clients.size}));
    return;
  }
  // Plain-request fallback for networks whose proxies buffer or block
  // streaming connections: the page polls the latest frame once a second.
  if (url.pathname === '/frame.jpg') {
    if (!latestFrame) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, {'content-type': 'image/jpeg', 'cache-control': 'no-store'});
    res.end(Buffer.from(latestFrame, 'base64'));
    return;
  }
  res.writeHead(404).end();
}).listen(Number(args.port), () => console.log(`streaming chrome://dino on http://localhost:${args.port}/stream (${chromeVersion})`));

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15_000);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    // Keep the run in progress in the history instead of losing it.
    if (s && s.current > 0) {
      history.push(withMeta({startedAt: s.runStartedAt, endedAt: Date.now(), score: s.current, speed: null,
        killedBy: 'stopped (stream restarted)', stopped: true}));
      saveHistory();
    }
    log({event: 'stop', stats: latestStats});
    await browser.close().catch(() => {});
    process.exit(0);
  });
}

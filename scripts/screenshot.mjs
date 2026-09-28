// Captures docs/screenshot.png from a running preview (node scripts/preview.ts).
import {chromium} from 'playwright';
const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const browser = await chromium.launch({channel: 'chrome'});
const page = await browser.newPage({viewport: {width: 1280, height: 900}, deviceScaleFactor: 2});
await page.goto(url);
await page.waitForTimeout(12_000); // let the champion run and the swarm evolve a little
await page.screenshot({path: 'docs/screenshot.png'});
await browser.close();
console.log('wrote docs/screenshot.png');

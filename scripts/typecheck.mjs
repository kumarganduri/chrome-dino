// Type-checks our code with tsc. Errors inside vendor/chromium-dino are
// Chromium's own typing environment (enums, Chrome-only page globals); the
// files are bundled unedited by esbuild, so they are reported but not fatal.
import {execFileSync} from 'node:child_process';

let out = '';
try {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', '.'], {encoding: 'utf8'});
} catch (e) {
  out = e.stdout ?? '';
}
const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));
const ours = errors.filter((l) => !l.startsWith('vendor/'));
console.log(`tsc: ${errors.length - ours.length} vendored-code notes (ignored), ${ours.length} errors in our code`);
if (ours.length) {
  console.log(ours.join('\n'));
  process.exit(1);
}

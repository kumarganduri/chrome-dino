// Bundles the unedited Chromium dino source for Node and the browser.
//
//   vendor/chromium-dino/dino_game/*.ts ──┐
//   src/engine/vendor-entry.ts ───────────┼─ esbuild ─► dist/engine.mjs      (Node, workers, tests)
//                                         │           └► dist/engine.iife.js (browser: window.DinoEngine)
//   chrome://resources/js/assert.js ──────┤  aliased to src/hook/stubs/assert.ts
//   chrome://resources/js/load_time_data.js ┤ aliased to src/hook/stubs/load_time_data.ts
//   ./constants.js (from vendored modules) ┘ aliased to src/hook/pinned-constants.ts
//                                             (Chrome's values, device flags pinned)
//
//   src/web/core.ts ─ esbuild ─► dist/core.js  (browser ESM: engine + Game + NEAT)
//
// The vendored files import siblings as './x.js'; we map those to the .ts files.
import * as esbuild from 'esbuild';
import {existsSync} from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const CHROME_IMPORTS = {
  'chrome://resources/js/assert.js': path.join(root, 'src/hook/stubs/assert.ts'),
  'chrome://resources/js/load_time_data.js': path.join(root, 'src/hook/stubs/load_time_data.ts'),
};

const chromiumResolver = {
  name: 'chromium-resolver',
  setup(build) {
    build.onResolve({filter: /^chrome:\/\//}, (args) => {
      const target = CHROME_IMPORTS[args.path];
      if (!target) {
        throw new Error(`Unmapped Chrome import ${args.path} in ${args.importer}`);
      }
      return {path: target};
    });
    // './foo.js' inside vendor → './foo.ts'; '../constants.js' → neterror_constants.ts
    build.onResolve({filter: /\.js$/}, (args) => {
      if (!args.importer.includes(`${path.sep}vendor${path.sep}chromium-dino${path.sep}`)) {
        return undefined;
      }
      if (args.path === './constants.js') {
        return {path: path.join(root, 'src/hook/pinned-constants.ts')};
      }
      if (args.path === '../constants.js') {
        return {path: path.join(root, 'vendor/chromium-dino/neterror_constants.ts')};
      }
      const ts = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
      if (!existsSync(ts)) {
        throw new Error(`Cannot resolve ${args.path} from ${args.importer}`);
      }
      return {path: ts};
    });
  },
};

const common = {
  entryPoints: [path.join(root, 'src/engine/vendor-entry.ts')],
  bundle: true,
  plugins: [chromiumResolver],
  target: 'es2022',
  logLevel: 'warning',
  legalComments: 'inline',
};

export async function build() {
  await Promise.all([
    esbuild.build({...common, format: 'esm', platform: 'neutral', outfile: path.join(root, 'dist/engine.mjs')}),
    esbuild.build({...common, format: 'iife', globalName: 'DinoEngine', platform: 'browser', outfile: path.join(root, 'dist/engine.iife.js')}),
    esbuild.build({...common, entryPoints: [path.join(root, 'src/web/core.ts')], format: 'esm', platform: 'browser', outfile: path.join(root, 'dist/core.js')}),
  ]);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await build();
  console.log('built dist/engine.mjs, dist/engine.iife.js');
}

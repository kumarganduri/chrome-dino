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
//   web/app.ts ────── esbuild ─► public/app.js (the site) + web/{index.html,style.css,
//                                favicon.svg,data/} and the sprite sheet copied to public/
//
// The vendored files import siblings as './x.js'; we map those to the .ts files.
import * as esbuild from 'esbuild';
import {cpSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
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

function copySite() {
  const pub = path.join(root, 'public');
  mkdirSync(path.join(pub, 'sprites'), {recursive: true});
  for (const f of ['index.html', 'style.css', 'favicon.svg']) cpSync(path.join(root, 'web', f), path.join(pub, f));
  // DINO_API (CI variable) points the published page at the live server.
  if (process.env.DINO_API) {
    writeFileSync(path.join(pub, 'config.js'), `window.DINO_API = ${JSON.stringify(process.env.DINO_API)};\n`);
  } else {
    cpSync(path.join(root, 'web/config.js'), path.join(pub, 'config.js'));
  }
  if (existsSync(path.join(root, 'web/data'))) cpSync(path.join(root, 'web/data'), path.join(pub, 'data'), {recursive: true});
  cpSync(path.join(root, 'vendor/chromium-dino/images/100-offline-sprite.png'), path.join(pub, 'sprites/100-offline-sprite.png'));
  cpSync(path.join(root, 'vendor/chromium-dino/LICENSE'), path.join(pub, 'CHROMIUM-LICENSE.txt'));
}

export async function build() {
  copySite();
  await Promise.all([
    esbuild.build({...common, entryPoints: [path.join(root, 'web/app.ts')], format: 'esm', platform: 'browser',
      outfile: path.join(root, 'public/app.js'), minify: true, sourcemap: true}),
    esbuild.build({...common, format: 'esm', platform: 'neutral', outfile: path.join(root, 'dist/engine.mjs')}),
    esbuild.build({...common, format: 'iife', globalName: 'DinoEngine', platform: 'browser', outfile: path.join(root, 'dist/engine.iife.js')}),
    esbuild.build({...common, entryPoints: [path.join(root, 'src/web/core.ts')], format: 'esm', platform: 'browser', outfile: path.join(root, 'dist/core.js')}),
    esbuild.build({...common, entryPoints: [path.join(root, 'src/web/inject.ts')], format: 'iife', globalName: 'DinoForever', platform: 'browser', outfile: path.join(root, 'dist/inject.js')}),
    esbuild.build({...common, entryPoints: [path.join(root, 'src/web/autopilot.ts')], format: 'iife', platform: 'browser', minify: true,
      legalComments: 'none', outfile: path.join(root, 'public/autopilot.js')}),
  ]);
  stampVersions();
}

// GitLab Pages lets browsers cache files for 10 minutes. Stamp index.html's
// references with content hashes so a cached page always loads the script and
// styles that belong to it, and a new page never runs against old ones.
function stampVersions() {
  const pub = path.join(root, 'public');
  const indexPath = path.join(pub, 'index.html');
  let html = readFileSync(indexPath, 'utf8');
  for (const file of ['app.js', 'style.css', 'config.js']) {
    const hash = createHash('sha256').update(readFileSync(path.join(pub, file))).digest('hex').slice(0, 10);
    html = html.replace(new RegExp(`(src|href)="${file.replace('.', '\\.')}"`, 'g'), `$1="${file}?v=${hash}"`);
  }
  writeFileSync(indexPath, html);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await build();
  console.log('built dist/engine.mjs, dist/engine.iife.js');
}

// Serves public/ locally: node scripts/preview.ts [port]
import path from 'node:path';
import {serve} from '../test/e2e/serve.ts';

const port = Number(process.argv[2] ?? 4173);
const {url} = await serve(path.resolve(import.meta.dirname, '../public'), port);
console.log(`dino.forever preview on ${url}`);

// Loads the vendored engine bundle in Node after pinning the environment.
import {installNodeEnv} from '../hook/env.ts';

export type Engine = typeof import('../../dist/engine.mjs');

let enginePromise: Promise<Engine> | null = null;

export function loadEngine(): Promise<Engine> {
  if (!enginePromise) {
    installNodeEnv();
    enginePromise = import(new URL('../../dist/engine.mjs', import.meta.url).href) as Promise<Engine>;
  }
  return enginePromise;
}

// Connection to the live server (optional). With no server configured or
// reachable the page runs fully locally; nothing here is required to watch.
//
//   GET  {api}/api/state   → snapshot of everything (champion, live run, stats, board)
//   GET  {api}/api/live    → server-sent events: state | run | crash | promotion | stats | board | kill
//   POST {api}/api/attack  → server replays the attack; answers kill / survived / illegal
//   POST {api}/api/run     → server replays a human race; answers the verified score
import type {Genome} from '../src/neat/genome.ts';
import type {Snapshot} from '../src/engine/game.ts';

export interface LiveRun {
  seed: number;
  startWall: number; // server clock, ms
  checkpoint: Snapshot | null;
  championVersion: number;
}

export interface BoardRow {
  name: string;
  value: number;
  detail?: string;
}

export interface LiveState {
  serverNow: number;
  champion: {version: number | null; genome: Genome; label: string; gen: number} | null;
  run: LiveRun | null;
  stats: {watchers: number; generation: number; runsVerified: number; attacksSurvived: number; kills: number; framesSimulated: number};
  board: {survival: BoardRow[]; killers: BoardRow[]; humans: BoardRow[]};
  history?: Array<{gen: number; best: number; mean: number; gateTried?: boolean; champion?: number | null}>;
}

export type LiveEvent =
  | {type: 'state'; state: LiveState}
  | {type: 'run'; run: LiveRun; serverNow: number}
  | {type: 'stats'; stats: LiveState['stats']}
  | {type: 'board'; board: LiveState['board']}
  | {type: 'promotion'; champion: NonNullable<LiveState['champion']>}
  | {type: 'crash'; crash: {seed: number; frames: number; obstacles: string; speed: number; snapshot: Snapshot; genome: Genome}}
  | {type: 'kill'; kill: {name: string; obstacles: string; speed: number; snapshot: Snapshot; genome: Genome}};

export function apiBase(): string | null {
  const fromQuery = new URLSearchParams(location.search).get('api');
  const configured = (window as {DINO_API?: string}).DINO_API;
  const base = fromQuery ?? configured ?? '';
  return base ? base.replace(/\/$/, '') : null;
}

export class LiveClient {
  readonly base: string;
  clockOffset = 0; // serverNow - Date.now()
  private source: EventSource | null = null;
  onEvent: (e: LiveEvent) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};

  constructor(base: string) {
    this.base = base;
  }

  async state(): Promise<LiveState> {
    const res = await fetch(`${this.base}/api/state`, {cache: 'no-store'});
    if (!res.ok) throw new Error(`state ${res.status}`);
    const s = (await res.json()) as LiveState;
    this.clockOffset = s.serverNow - Date.now();
    return s;
  }

  connect(): void {
    this.source?.close();
    const es = new EventSource(`${this.base}/api/live`);
    this.source = es;
    es.onopen = () => this.onStatus(true);
    es.onerror = () => this.onStatus(false); // EventSource retries by itself
    for (const type of ['state', 'run', 'stats', 'board', 'promotion', 'crash', 'kill']) {
      es.addEventListener(type, (m) => {
        const data = JSON.parse((m as MessageEvent).data);
        if (type === 'state') this.clockOffset = data.serverNow - Date.now();
        if (type === 'run') this.clockOffset = data.serverNow - Date.now();
        this.onEvent({type, ...(type === 'state' ? {state: data} : data)} as LiveEvent);
      });
    }
  }

  /** Server wall clock converted to this browser's Date.now() frame. */
  toLocal(serverMs: number): number {
    return serverMs - this.clockOffset;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({error: `HTTP ${res.status}`}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json as T;
  }
}

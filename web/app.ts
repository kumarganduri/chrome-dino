// Page bootstrap. Everything works offline from the bundled data/*.json; a
// live server (window.DINO_API or ?api=) upgrades the page to the shared
// live run, the global board and verified attacks.
//
//   data/champion.json | data/leader.json ─► ChampionView (hero + clock)
//   in-tab NEAT ──────────────────────────► Swarm
//   champion or focused ghost ────────────► BrainView
//   data/history.json (+ live stats) ─────► FitnessChart
//   data/graveyard.json + live crashes ───► Graveyard
//   /api/live (SSE) ──────────────────────► live run, board, counters
import {Network, validateGenome, type Genome} from '../src/web/core.ts';
import {$, formatInt, loadImage, SPRITE_URL} from './runtime.ts';
import {ChampionView, randomSeed, type ChampionInfo, type CrashEvent} from './champion-view.ts';
import {Swarm} from './swarm.ts';
import {BrainView} from './brain-view.ts';
import {FitnessChart, type ChartRow} from './chart.ts';
import {Graveyard, type Grave} from './graveyard.ts';
import {PlayDialog} from './play.ts';
import {apiBase, LiveClient, type BoardRow, type LiveState} from './live.ts';

interface PublishedChampion {
  version: number;
  gen: number;
  genome: Genome;
  gate: {seeds: number; passed: number; framesPerSeed: number; heldOutSeeds?: number; heldOutPassed?: number} | null;
}
interface PublishedStats {
  generations: number;
  framesSimulated: number;
  curriculum: number;
  championVersion: number | null;
  publishedAt: string;
  oracle?: {seeds: number; survived: number; gameHoursPerSeed: number} | null;
  validation?: {seeds: number; survived: number; minutes: number; gameHours: number; crashes: number} | null;
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {cache: 'no-cache'});
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function setPressed(group: HTMLElement, btn: HTMLElement) {
  for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
}

// A shared run needs no server: (seed, start time, champion) fix every frame,
// so every browser computes the same run from the wall clock, starting from
// the latest published hourly checkpoint (trainer/shared-run.ts).
interface SharedRun {
  seed: number;
  startWall: number;
  startedAt: string;
  championVersion: number;
  checkpointEvery: number;
  verifiedUntilFrame: number;
  verifiedUntil: string;
}

const localRecords = {longest: 0, kills: [] as BoardRow[], humans: [] as BoardRow[]};

async function main() {
  const [sprite, champion, leader, history, graves, stats, lessons, sharedRun] = await Promise.all([
    loadImage(SPRITE_URL),
    json<PublishedChampion>('data/champion.json'),
    json<{gen: number; genome: Genome}>('data/leader.json'),
    json<ChartRow[]>('data/history.json'),
    json<any[]>('data/graveyard.json'),
    json<PublishedStats>('data/stats.json'),
    json<any[]>('data/lessons.json'),
    json<SharedRun>('data/live/run.json'),
  ]);

  const champInfo = (): ChampionInfo | null => {
    if (champion) return {version: champion.version, genome: validateGenome(champion.genome), label: `champion v${champion.version}`};
    if (leader) return {version: null, genome: validateGenome(leader.genome), label: `leader · gen ${leader.gen} · still training`};
    return null;
  };
  let current = champInfo();

  // ── Hero ────────────────────────────────────────────────────────────────
  const shared = sharedRun && current && sharedRun.championVersion === current.version ? sharedRun : null;
  const sharedSince = shared ? new Date(shared.startWall).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) : '';
  const view = new ChampionView($('#champion') as HTMLCanvasElement, sprite);
  const tag = $('#champion-tag');
  const proof = $('#proof');
  const setProof = () => {
    const lines: string[] = [];
    if (champion?.gate) {
      lines.push(`<b>✓ gate</b>: ${formatInt(champion.gate.passed)}/${formatInt(champion.gate.seeds)} tracks × 30 min at top speed, zero crashes`);
      if (champion.gate.heldOutSeeds) {
        lines.push(`<b>✓ held-out</b>: ${formatInt(champion.gate.heldOutPassed ?? 0)}/${formatInt(champion.gate.heldOutSeeds)} unseen tracks × 60 min`);
      }
    } else if (current) {
      lines.push('Still training; not yet gate-proven.');
    }
    const v = stats?.validation;
    if (v) {
      lines.push(`<span class="muted">Validation: ${formatInt(v.survived)}/${formatInt(v.seeds)} unseen tracks × ${v.minutes / 60} h ` +
        `(${formatInt(v.gameHours)} game-hours, ${v.crashes} crash${v.crashes === 1 ? '' : 'es'}).</span>`);
    }
    if (stats?.oracle) {
      lines.push(`<span class="muted">Forever is possible: a lookahead oracle survived ${stats.oracle.survived}/${stats.oracle.seeds} tracks × ${stats.oracle.gameHoursPerSeed.toFixed(1)} h.</span>`);
    }
    if (shared) {
      const until = new Date(shared.verifiedUntil).toLocaleDateString(undefined, {dateStyle: 'medium'});
      lines.push(`<b>✓ this run</b>: simulated ahead and verified crash-free through ${until}. Every browser computes the same run.`);
    }
    proof.innerHTML = lines.join('<br>');
  };
  setProof();

  const pill = $('#live-pill');
  const pillText = $('#live-text');

  async function joinSharedRun(): Promise<boolean> {
    if (!shared || !current) return false;
    const now = Math.floor((Date.now() - shared.startWall) / (1000 / 60));
    const cpFrame = Math.min(Math.floor(now / shared.checkpointEvery) * shared.checkpointEvery, shared.verifiedUntilFrame);
    const checkpoint = await json<any>(`data/live/${cpFrame}.json`);
    if (!checkpoint) return false;
    const spec = {seed: shared.seed, startWall: shared.startWall, checkpoint};
    if (!view.game) view.start(current, spec);
    else view.begin(spec);
    view.autoRestart = false;
    tag.textContent = `${current.label} · shared live run since ${sharedSince}`;
    pill.dataset.state = 'live';
    pillText.textContent = 'live · shared run';
    return true;
  }

  if (!current) {
    tag.textContent = 'no trained brain published yet';
  } else if (!(await joinSharedRun())) {
    tag.textContent = current.label;
    view.start(current, {seed: randomSeed(), startWall: Date.now()});
  }

  const graveyard = new Graveyard($('#graves'), $('#replay') as HTMLCanvasElement, $('#replay-caption'), sprite);
  for (const g of (graves ?? []).slice().reverse()) {
    graveyard.add({
      id: `t${g.gen}-${g.caseId}-${g.frames}`,
      title: g.source === 'gate' ? `gen ${g.gen}` : `gen ${g.gen}`,
      source: g.source === 'gate' ? 'gate' : 'training',
      obstacles: g.obstacles, speed: g.speed, snapshot: g.snapshot, genome: g.genome,
    }, false);
  }

  // Past crashes (the curriculum), replayed with today's champion. Lessons from
  // before its promotion are ones it had to clear; newer ones are still in training.
  if (current) {
    const championGen = champion?.gen ?? Infinity;
    const list = (lessons ?? []).filter((x) => !x.unclearable)
        .sort((a, b) => Number(a.gen > championGen) - Number(b.gen > championGen) || b.gen - a.gen).slice(0, 40);
    for (const l of list) {
      const learned = l.gen <= championGen;
      graveyard.add({id: `lesson-${l.id}`, title: `${learned ? 'lesson' : 'new lesson'} · gen ${l.gen}`,
        source: l.source === 'gate' ? 'gate' : 'training', obstacles: l.obstacles, speed: l.speed, snapshot: l.snapshot,
        genome: current.genome, replayedBy: current.label}, false);
    }
  }

  let crashCount = 0;
  view.onCrash = (e: CrashEvent) => {
    crashCount++;
    localRecords.longest = Math.max(localRecords.longest, e.frames);
    graveyard.add({id: `live-${e.seed}-${e.frames}`, title: e.source === 'live' ? 'live run' : `this tab #${crashCount}`,
      source: e.source === 'live' ? 'live' : 'local', obstacles: e.obstacles, speed: e.speed, score: e.score,
      snapshot: e.snapshot, genome: e.genome});
    renderBoard();
  };

  const clock = $('#clock');
  const sScore = $('#stat-score');
  const sSpeed = $('#stat-speed');
  const sFrame = $('#stat-frame');

  // ── Brain ───────────────────────────────────────────────────────────────
  const brain = new BrainView($('#brain') as HTMLCanvasElement);
  let brainSource: 'champion' | 'swarm' = 'champion';
  const brainGroup = $('#brain-source');
  brainGroup.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    brainSource = b.dataset.src as 'champion' | 'swarm';
    setPressed(brainGroup, b);
  });
  const brainCaption = $('#brain-caption');

  // ── Swarm ───────────────────────────────────────────────────────────────
  const swarm = new Swarm($('#swarm') as HTMLCanvasElement, sprite, randomSeed());
  swarm.speed = 4;
  const speedGroup = $('#swarm-speed');
  speedGroup.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    swarm.speed = Number(b.dataset.speed);
    setPressed(speedGroup, b);
  });
  swarm.onBestCrash = (c) => graveyard.add({id: `swarm-${c.gen}`, title: `your tab gen ${c.gen}`, source: 'swarm',
    obstacles: c.obstacles, speed: 0, score: Math.round(c.frames / 60)});
  swarm.start();
  const swarmLabel = $('#swarm-label');
  $('#swarm').addEventListener('click', () => {
    brainSource = 'swarm';
    setPressed(brainGroup, brainGroup.querySelector('[data-src="swarm"]')!);
  });

  // ── Chart + training stats ─────────────────────────────────────────────
  const chart = new FitnessChart($('#chart') as HTMLCanvasElement, $('#chart-tip'));
  chart.set(history ?? []);
  const trainStats = $('#train-stats');
  const renderTrainStats = (s: {generations: number; frames: number; curriculum?: number; champion: number | null}) => {
    const rows: Array<[string, string]> = [
      ['Generations', formatInt(s.generations)],
      ['Frames simulated', s.frames > 1e9 ? `${(s.frames / 1e9).toFixed(2)} B` : `${(s.frames / 1e6).toFixed(1)} M`],
      ['Lessons (crashes)', s.curriculum !== undefined ? formatInt(s.curriculum) : '–'],
      ['Champion', s.champion ? `v${s.champion}` : 'none yet'],
    ];
    trainStats.replaceChildren(...rows.map(([k, v]) => {
      const d = document.createElement('div');
      d.innerHTML = '<dt></dt><dd></dd>';
      d.querySelector('dt')!.textContent = k;
      d.querySelector('dd')!.textContent = v;
      return d;
    }));
  };
  if (stats) renderTrainStats({generations: stats.generations, frames: stats.framesSimulated, curriculum: stats.curriculum, champion: stats.championVersion});

  // ── Board ───────────────────────────────────────────────────────────────
  const board = $('#board');
  let liveBoard: LiveState['board'] | null = null;
  let liveCounters: LiveState['stats'] | null = null;
  const list = (title: string, rows: BoardRow[], fmt: (r: BoardRow) => string, empty: string) => {
    const wrap = document.createElement('section');
    const h = document.createElement('h3');
    h.textContent = title;
    const ol = document.createElement('ol');
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = empty;
      ol.append(li);
    }
    rows.slice(0, 5).forEach((r, i) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="rank"></span><span class="who"></span><span class="val"></span>';
      li.querySelector('.rank')!.textContent = String(i + 1);
      li.querySelector('.who')!.textContent = r.name + (r.detail ? ` · ${r.detail}` : '');
      li.querySelector('.val')!.textContent = fmt(r);
      ol.append(li);
    });
    wrap.append(h, ol);
    return wrap;
  };
  const secs = (r: BoardRow) => {
    const s = Math.round(r.value);
    return s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };
  function renderBoard() {
    const parts: HTMLElement[] = [];
    if (liveCounters) {
      const c = document.createElement('div');
      c.className = 'counters';
      c.innerHTML = [
        ['watching', liveCounters.watchers], ['runs verified', liveCounters.runsVerified],
        ['attacks survived', liveCounters.attacksSurvived], ['kills ever', liveCounters.kills],
      ].map(([k, v]) => `<span><b>${formatInt(v as number)}</b>${k}</span>`).join('');
      parts.push(c);
    }
    if (liveBoard) {
      parts.push(list('Longest survival', liveBoard.survival, secs, 'No runs yet.'));
      parts.push(list('Top killers', liveBoard.killers, (r) => `${r.value} kill${r.value === 1 ? '' : 's'}`, 'Nobody has killed it. Yet.'));
      parts.push(list('Fastest humans', liveBoard.humans, secs, 'Race it to get on the board.'));
    } else {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = shared ?
        'Everyone who opens this page sees this same run. Kills and races below count in this tab only.' :
        'The live global board appears when the live server is running. Records below are from this tab.';
      parts.push(note);
      if (shared) {
        parts.push(list('Shared live run', [
          {name: `${current?.label ?? 'champion'}`, value: (view.game?.frame ?? 0) / 60, detail: `since ${sharedSince}`},
        ], secs, ''));
      } else {
        parts.push(list('This tab', [
          {name: 'champion, longest run', value: Math.max(localRecords.longest, view.game?.frame ?? 0) / 60},
        ], secs, ''));
      }
      parts.push(list('Your kills', localRecords.kills, (r) => `${r.value}`, 'Try to kill it.'));
      parts.push(list('Your races', localRecords.humans, secs, 'Race it.'));
    }
    board.replaceChildren(...parts);
  }

  // ── Live server ─────────────────────────────────────────────────────────
  const api = apiBase();
  const live = api ? new LiveClient(api) : null;
  let liveRun: {seed: number; championVersion: number} | null = null;
  if (live) {
    if (!shared) pillText.textContent = 'connecting…';
    const applyState = (s: LiveState) => {
      if (s.champion) {
        current = {version: s.champion.version, genome: validateGenome(s.champion.genome), label: s.champion.label};
        view.setChampion(current);
        tag.textContent = current.label;
      }
      if (s.run && current) {
        liveRun = {seed: s.run.seed, championVersion: s.run.championVersion};
        const spec = {seed: s.run.seed, startWall: live.toLocal(s.run.startWall), checkpoint: s.run.checkpoint};
        if (!view.game) view.start(current, spec);
        else view.begin(spec);
        view.autoRestart = false; // the server announces the next run
      }
      liveBoard = s.board;
      liveCounters = s.stats;
      if (s.history) chart.set(s.history);
      renderTrainStats({generations: s.stats.generation, frames: s.stats.framesSimulated, champion: s.champion?.version ?? null});
      renderBoard();
    };
    live.onStatus = (ok) => {
      pill.dataset.state = ok ? 'live' : 'offline';
      pillText.textContent = ok ? `live · ${formatInt(liveCounters?.watchers ?? 1)} watching` : 'reconnecting…';
    };
    live.onEvent = (e) => {
      switch (e.type) {
        case 'state': applyState(e.state); break;
        case 'run':
          liveRun = {seed: e.run.seed, championVersion: e.run.championVersion};
          view.begin({seed: e.run.seed, startWall: live.toLocal(e.run.startWall), checkpoint: e.run.checkpoint});
          break;
        case 'stats':
          liveCounters = e.stats;
          pillText.textContent = `live · ${formatInt(e.stats.watchers)} watching`;
          renderBoard();
          break;
        case 'board': liveBoard = e.board; renderBoard(); break;
        case 'promotion':
          current = {version: e.champion.version, genome: validateGenome(e.champion.genome), label: e.champion.label};
          view.setChampion(current);
          tag.textContent = `${current.label} took over`;
          break;
        case 'kill':
          graveyard.add({id: `kill-${e.kill.name}-${Date.now()}`, title: `killed by ${e.kill.name}`, source: 'attack',
            obstacles: e.kill.obstacles, speed: e.kill.speed, snapshot: e.kill.snapshot, genome: e.kill.genome});
          break;
        case 'crash': break; // the page detects the same crash itself (deterministic)
      }
    };
    // Open the live stream only once the server answers; otherwise stay in
    // local mode quietly instead of retrying forever.
    live.state().then((s) => {
      applyState(s);
      live.connect();
    }).catch(() => {
      if (!shared) {
        pill.dataset.state = 'offline';
        pillText.textContent = 'local';
      }
      renderBoard();
    });
  } else if (!shared) {
    pillText.textContent = 'local';
  }
  renderBoard();

  // ── Play modes ──────────────────────────────────────────────────────────
  const play = new PlayDialog({
    sprite,
    championGame: () => view.game,
    championGenome: () => current!.genome,
    championVersion: () => current?.version ?? null,
    liveRunId: () => liveRun,
    live,
    onKill: (k) => {
      const prev = localRecords.kills.find((r) => r.name === k.name);
      if (prev) prev.value++;
      else localRecords.kills.push({name: k.name, value: 1});
      graveyard.add({id: `kill-${Date.now()}`, title: `killed by ${k.name}`, source: 'attack', obstacles: k.obstacles,
        speed: k.speed, snapshot: k.snapshot ?? undefined, genome: k.genome});
      renderBoard();
    },
    onRace: (r) => {
      localRecords.humans.push({name: r.name, value: r.seconds, detail: `score ${r.score}`});
      localRecords.humans.sort((a, b) => b.value - a.value);
      renderBoard();
    },
  });
  const attackBtn = $('#btn-attack') as HTMLButtonElement;
  const raceBtn = $('#btn-race') as HTMLButtonElement;
  attackBtn.disabled = raceBtn.disabled = !current;
  attackBtn.addEventListener('click', () => play.attack());
  raceBtn.addEventListener('click', () => play.race());

  // ── Per-frame UI ────────────────────────────────────────────────────────
  let lastBoard = 0;
  const frame = () => {
    if (view.game) {
      const s = view.stats();
      clock.textContent = s.clock;
      sScore.textContent = s.score;
      sSpeed.textContent = s.speed;
      sFrame.textContent = s.frame;
    }
    swarmLabel.textContent = swarm.label();
    if (brainSource === 'champion' && view.policy && current) {
      brain.show(current.genome, view.policy.net);
      brainCaption.textContent = `${current.label} · ${brain.describe()}`;
    } else {
      const ghost = swarm.focus();
      if (ghost) {
        brain.show(swarm.pop.members[ghost.memberIndex]!.genome, ghost.policy.net);
        brainCaption.textContent = `your tab · generation ${swarm.generation} · ${brain.describe()}`;
      }
    }
    brain.render();
    if (!liveBoard && performance.now() - lastBoard > 1000) {
      lastBoard = performance.now();
      renderBoard();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (window as any).dino = {view, swarm, brain, Network};
}

main().catch((e) => {
  console.error(e);
  const tag = document.getElementById('champion-tag');
  if (tag) tag.textContent = `failed to start: ${e.message}`;
});

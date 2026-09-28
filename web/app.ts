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
  gate: {seeds: number; passed: number; framesPerSeed: number} | null;
}
interface PublishedStats {
  generations: number;
  framesSimulated: number;
  curriculum: number;
  championVersion: number | null;
  publishedAt: string;
  oracle?: {seeds: number; survived: number; gameHoursPerSeed: number} | null;
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

const localRecords = {longest: 0, kills: [] as BoardRow[], humans: [] as BoardRow[]};

async function main() {
  const [sprite, champion, leader, history, graves, stats] = await Promise.all([
    loadImage(SPRITE_URL),
    json<PublishedChampion>('data/champion.json'),
    json<{gen: number; genome: Genome}>('data/leader.json'),
    json<ChartRow[]>('data/history.json'),
    json<any[]>('data/graveyard.json'),
    json<PublishedStats>('data/stats.json'),
  ]);

  const champInfo = (): ChampionInfo | null => {
    if (champion) return {version: champion.version, genome: validateGenome(champion.genome), label: `champion v${champion.version}`};
    if (leader) return {version: null, genome: validateGenome(leader.genome), label: `leader · gen ${leader.gen} · still training`};
    return null;
  };
  let current = champInfo();

  // ── Hero ────────────────────────────────────────────────────────────────
  const view = new ChampionView($('#champion') as HTMLCanvasElement, sprite);
  const tag = $('#champion-tag');
  const proof = $('#proof');
  const setProof = () => {
    if (champion?.gate) {
      proof.innerHTML = `<b>✓ proven</b>: ${formatInt(champion.gate.passed)}/${formatInt(champion.gate.seeds)} fresh tracks × 30 min at top speed, zero crashes`;
    } else if (current) {
      proof.textContent = 'Still training; not yet gate-proven.';
    }
    if (stats?.oracle) {
      proof.innerHTML += `<br><span class="muted">Feasibility: a lookahead oracle survived ${stats.oracle.survived}/${stats.oracle.seeds} tracks × ${stats.oracle.gameHoursPerSeed.toFixed(1)} h.</span>`;
    }
  };
  setProof();

  if (!current) {
    tag.textContent = 'no trained brain published yet';
  } else {
    tag.textContent = `${current.label} · Chrome's real T-Rex (Chromium 644979367a)`;
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
      note.textContent = api ? 'Server unreachable. Showing this tab only.' : 'Running locally. Records below are from this tab.';
      parts.push(note);
      parts.push(list('This tab', [
        {name: 'champion, longest run', value: Math.max(localRecords.longest, view.game?.frame ?? 0) / 60},
      ], secs, ''));
      parts.push(list('Your kills', localRecords.kills, (r) => `${r.value}`, 'Try to kill it.'));
      parts.push(list('Your races', localRecords.humans, secs, 'Race it.'));
    }
    board.replaceChildren(...parts);
  }

  // ── Live server ─────────────────────────────────────────────────────────
  const api = apiBase();
  const live = api ? new LiveClient(api) : null;
  const pill = $('#live-pill');
  const pillText = $('#live-text');
  let liveRun: {seed: number; championVersion: number} | null = null;
  if (live) {
    pillText.textContent = 'connecting…';
    const applyState = (s: LiveState) => {
      if (s.champion) {
        current = {version: s.champion.version, genome: validateGenome(s.champion.genome), label: s.champion.label};
        view.setChampion(current);
        tag.textContent = `${current.label} · Chrome's real T-Rex (Chromium 644979367a)`;
      }
      if (s.run && current) {
        liveRun = {seed: s.run.seed, championVersion: s.run.championVersion};
        const spec = {seed: s.run.seed, startWall: live.toLocal(s.run.startWall), checkpoint: s.run.checkpoint};
        if (!view.game) view.start(current, spec);
        else view.begin(spec);
        view.nextSeed = () => ({seed: randomSeed(), startWall: Date.now()}); // server will announce the next run
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
          tag.textContent = `${current.label} took over · Chrome's real T-Rex`;
          break;
        case 'kill':
          graveyard.add({id: `kill-${e.kill.name}-${Date.now()}`, title: `killed by ${e.kill.name}`, source: 'attack',
            obstacles: e.kill.obstacles, speed: e.kill.speed, snapshot: e.kill.snapshot, genome: e.kill.genome});
          break;
        case 'crash': break; // the page detects the same crash itself (deterministic)
      }
    };
    live.state().then(applyState).catch(() => {
      pill.dataset.state = 'offline';
      pillText.textContent = 'offline · local';
    });
    live.connect();
  } else {
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

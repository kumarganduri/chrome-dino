// "Literal chrome://dino" panel: a live stream of a real Google Chrome tab
// playing chrome://dino with the champion (scripts/real-chrome-live.mjs),
// relayed from one machine. Unlike the shared run, it uses Chrome's real clock
// and randomness, so it can't be recomputed here; it is streamed.
import {$, formatDuration, formatInt} from './runtime.ts';

interface RunRow {
  startedAt: number;
  endedAt?: number;
  score: number;
  killedBy?: string;
  ongoing?: boolean;
  stopped?: boolean;
  shot?: string | null; // proof screenshot served by the streamer at /shot/<file>
}

interface Stats {
  chrome: string;
  champion: number | null;
  streamingSince: number;
  runStartedAt: number;
  now: number;
  score: number;
  best: number;
  crashes: number;
  record?: RunRow;
  totalRuns?: number;
  recent?: RunRow[];
  top?: RunRow[];
}

const endedBy = (r: RunRow) => (r.stopped ? 'no crash (stream restarted)' : `crash: ${r.killedBy ?? 'obstacle'}`);
const when = (ms: number) => new Date(ms).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'});

export function realChromeUrl(): string | null {
  const q = new URLSearchParams(location.search).get('realchrome');
  const configured = (window as {DINO_REAL_CHROME?: string}).DINO_REAL_CHROME;
  const base = q ?? configured ?? '';
  return base ? base.replace(/\/$/, '') : null;
}

export function startRealChromePanel(): void {
  const section = $('#real-chrome');
  const base = realChromeUrl();
  if (!base) return; // not configured: the panel stays hidden
  section.hidden = false;
  const img = $('#real-frame') as HTMLImageElement;
  const status = $('#real-status');
  const clock = $('#real-clock');
  const score = $('#real-score');
  const crashes = $('#real-crashes');
  const since = $('#real-since');
  let stats: Stats | null = null;
  let offset = 0; // streamer clock − our clock
  let lastEvent = 0;

  const showStats = (next: Stats) => {
    lastEvent = Date.now();
    stats = next;
    offset = stats.now - Date.now();
    score.textContent = formatInt(stats.score);
    crashes.textContent = formatInt(stats.crashes);
    since.textContent = new Date(stats.streamingSince).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
    status.textContent = `live from one machine · ${stats.chrome} · champion v${stats.champion ?? '?'}`;
    section.dataset.state = 'live';
    renderRecord(stats);
  };
  const recordBox = $('#real-record');
  const recordText = $('#real-record-text');
  const total = $('#real-total');
  const tbody = $('#real-history');
  // Top 3 runs as thumbnails; clicking opens the full screenshot.
  const top = $('#real-top');
  const dialog = document.getElementById('shot-dialog') as HTMLDialogElement;
  const big = $('#shot-big') as HTMLImageElement;
  const cap = $('#shot-cap');
  big.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  let topKey = '';
  const renderTop = (st: Stats) => {
    const rows = st.top ?? [];
    const key = JSON.stringify(rows.map((r) => [r.startedAt, r.ongoing ? 'live' : r.score, r.shot]));
    const medal = ['🥇', '🥈', '🥉'];
    const describe = (r: RunRow) => `score ${formatInt(r.score)} · ${formatDuration((r.ongoing ? st.now : (r.endedAt ?? st.now)) - r.startedAt)}` +
      ` · ${when(r.startedAt)} → ${r.ongoing ? 'still running' : when(r.endedAt ?? st.now)} · ${r.ongoing ? 'live now' : endedBy(r)}`;
    if (key === topKey) {
      // Only the live run's numbers change: update text in place, keep images.
      top.querySelectorAll<HTMLElement>('.top-card').forEach((card, i) => {
        const r = rows[i];
        if (!r) return;
        card.querySelector('.top-rank')!.textContent = `${medal[i]} ${formatInt(r.score)}`;
        card.querySelector('.top-meta')!.textContent = describe(r);
      });
      return;
    }
    topKey = key;
    top.replaceChildren(...rows.map((r, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `top-card${r.ongoing ? ' live-now' : ''}`;
      const src = r.shot ? `${base}/shot/${r.shot}` : null;
      const thumb = src ? Object.assign(document.createElement('img'), {src, alt: `Run ${i + 1} screenshot`, loading: 'lazy'}) :
        Object.assign(document.createElement('div'), {textContent: r.ongoing ? 'live now (see above)' : 'no picture'});
      thumb.className = `top-thumb${src ? '' : ' none'}`;
      const rank = Object.assign(document.createElement('span'), {className: 'top-rank', textContent: `${medal[i]} ${formatInt(r.score)}`});
      const meta = Object.assign(document.createElement('span'), {className: 'top-meta', textContent: describe(r)});
      card.append(thumb, rank, meta);
      if (src) {
        card.addEventListener('click', () => {
          big.src = src;
          big.alt = `Run screenshot: ${describe(r)}`;
          cap.textContent = `${medal[i]} ${describe(r)}`;
          dialog.showModal();
        });
      } else {
        card.disabled = true;
      }
      return card;
    }));
  };

  const renderRecord = (st: Stats) => {
    renderTop(st);
    if (!st.record) return;
    recordBox.hidden = false;
    const r = st.record;
    const end = r.ongoing ? st.now : (r.endedAt ?? st.now);
    recordText.textContent = `score ${formatInt(r.score)} · lasted ${formatDuration(end - r.startedAt)} · ` +
      `${when(r.startedAt)} → ${r.ongoing ? 'still running' : when(end)}` +
      (r.ongoing ? '' : ` · ${endedBy(r)}`);
    total.textContent = formatInt(st.totalRuns ?? 0);
    tbody.replaceChildren(...(st.recent ?? []).map((row) => {
      const tr = document.createElement('tr');
      if (row.startedAt === r.startedAt && !r.ongoing) tr.className = 'is-record';
      const cells = [when(row.startedAt), row.endedAt ? when(row.endedAt) : '–',
        formatDuration((row.endedAt ?? st.now) - row.startedAt), formatInt(row.score), endedBy(row)];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      return tr;
    }));
  };
  const offline = () => {
    section.dataset.state = 'offline';
    status.textContent = 'The machine running the real Chrome tab is not streaming right now.';
  };

  // Preferred: a live stream (server-sent events, ~10 frames/s).
  const es = new EventSource(`${base}/stream`);
  es.addEventListener('frame', (m) => {
    lastEvent = Date.now();
    img.src = `data:image/jpeg;base64,${JSON.parse((m as MessageEvent).data).jpeg}`;
    section.dataset.state = 'live';
  });
  es.addEventListener('stats', (m) => showStats(JSON.parse((m as MessageEvent).data) as Stats));
  es.onerror = () => {
    if (Date.now() - lastEvent > 5000 && !polling) offline();
  };

  // Fallback for strict networks whose proxies buffer or block streaming:
  // if no stream event arrives within 6 s, poll a plain image + stats each second.
  let polling = false;
  setTimeout(() => {
    if (lastEvent) return;
    polling = true;
    es.close();
    const poll = async () => {
      try {
        const res = await fetch(`${base}/status`, {cache: 'no-store'});
        if (!res.ok) throw new Error(String(res.status));
        showStats((await res.json()) as Stats);
        img.src = `${base}/frame.jpg?t=${Date.now()}`;
        status.textContent += ' · compatibility mode (1 frame/s)';
      } catch {
        offline();
      }
      setTimeout(poll, 1000);
    };
    void poll();
  }, 6000);

  const tick = () => {
    if (stats && section.dataset.state === 'live') {
      clock.textContent = formatDuration(Date.now() + offset - stats.runStartedAt);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

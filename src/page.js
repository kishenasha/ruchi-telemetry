/**
 * The shared chrome: one stylesheet, the nav, and the small formatters every
 * page uses. Nothing here reads the database.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const MICROS_PER_USD = 1_000_000;

// A person who somehow reached an AI call without a verified identity still
// gets counted, under a name that cannot collide with a real 64-hex hash.
export const NO_IDENTITY = 'anonymous';

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function money(micros) {
  const usd = (micros || 0) / MICROS_PER_USD;
  if (usd === 0) return '$0';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function count(n) {
  return (n || 0).toLocaleString('en-US');
}

export function when(value) {
  return esc((value || '').slice(0, 16).replace('T', ' '));
}

// A stable, readable name for a hash nobody can read. The same person is the
// same name on every visit, which is the whole point: recognisable across
// visits without the dashboard ever holding anything personal. Derived from
// the hash itself, so it needs no storage and no new data collection.
const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'clever', 'copper', 'crisp', 'dusky', 'eager',
  'fair', 'gentle', 'glad', 'golden', 'humble', 'jolly', 'keen', 'lively',
  'lucky', 'merry', 'mellow', 'nimble', 'noble', 'olive', 'plucky', 'quiet',
  'rapid', 'rustic', 'sage', 'silver', 'sunny', 'swift', 'tidy', 'warm',
];
const ANIMALS = [
  'badger', 'bison', 'crane', 'dingo', 'eagle', 'falcon', 'ferret', 'finch',
  'gecko', 'heron', 'ibex', 'jackal', 'koala', 'lemur', 'lynx', 'magpie',
  'marten', 'otter', 'owl', 'panda', 'quail', 'rabbit', 'raven', 'robin',
  'seal', 'shrew', 'sparrow', 'stoat', 'tapir', 'teal', 'vole', 'wren',
];

export function nickname(hash) {
  if (!HEX64.test(hash || '')) return NO_IDENTITY;
  const pick = (from, at) => from[parseInt(hash.slice(at, at + 4), 16) % from.length];
  const number = String(parseInt(hash.slice(8, 12), 16) % 100).padStart(2, '0');
  return `${pick(ADJECTIVES, 0)}-${pick(ANIMALS, 4)}-${number}`;
}

const GRADE_CLASS = { pro: ' tag--pro', trial: ' tag--trial' };

export function gradeTag(grade, label) {
  return `<span class="tag${GRADE_CLASS[grade] ?? ''}">${esc(label)}</span>`;
}

export function planTag(plan) {
  const label = plan === 'pro' ? 'Pro' : plan === 'free' ? 'Free' : (plan || 'unknown');
  return `<span class="tag${plan === 'pro' ? ' tag--pro' : ''}">${esc(label)}</span>`;
}

// Spend is only as complete as the provider's own cost reporting, so a row
// holding calls whose cost never came back says so rather than implying the
// total is the whole story.
export function pricedNote(row) {
  const missing = (row.calls || 0) - (row.priced || 0);
  return missing > 0 ? ` <span class="warn note">${count(missing)} unpriced</span>` : '';
}

// A bare red digit says nothing about how bad it is. Out of how many does.
export function failures(row) {
  if (!row.errors) return '<span class="dim">none</span>';
  return `<span class="warn">${count(row.errors)} of ${count(row.calls)}</span>`;
}

// Silent when the value is the one the services are enforcing, which is
// almost always. A row that says nothing here is a row that is fine.
export function state(row) {
  return row.custom && !row.applied
    ? '<span class="warn note">not applied, the servers still have the old value</span>'
    : '';
}

export const WINDOWS = [
  { key: 'today', label: 'Today', days: 1 },
  { key: 'week', label: '7 days', days: 7 },
  { key: 'month', label: '30 days', days: 30 },
  { key: 'all', label: 'All time', days: null },
];

/** The days a window covers, spelled out. Four windows agreeing looks like a
 * broken switch until you can see they cover the same day. */
export function rangeLabel(chosen) {
  if (chosen.days === null) return 'Everything so far';
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  return chosen.days === 1 ? day(0) : `${day(chosen.days - 1)} to ${day(0)}`;
}

export function windowFrom(url) {
  return WINDOWS.find((w) => w.key === url.searchParams.get('w')) ?? WINDOWS[2];
}

/** The window switcher, keeping whatever else the current page had in the URL. */
export function windowPicker(url, chosen) {
  return `<nav class="seg">${WINDOWS.map((w) => {
    const next = new URL(url);
    next.searchParams.set('w', w.key);
    next.searchParams.delete('p');
    return `<a class="${w.key === chosen.key ? 'on' : ''}" href="${esc(next.pathname + next.search)}">${esc(w.label)}</a>`;
  }).join('')}</nav>`;
}

/**
 * A headline number, with how it compares to the window before it. The
 * comparison is the point: a spend total means little without knowing whether
 * it is climbing.
 */
export function stat(label, value, { sub = '', now = null, before = null, invert = false } = {}) {
  let change = '';
  if (now !== null && before) {
    const pct = Math.round(((now - before) / before) * 100);
    if (pct !== 0) {
      const bad = invert && pct > 0;
      change = `<span class="delta ${bad ? 'delta--warn' : ''}">${pct > 0 ? '+' : ''}${pct}%</span>`;
    }
  }
  return `
    <div class="stat">
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-big">${value}${change}</span>
      <span class="stat-sub">${sub}</span>
    </div>`;
}

/**
 * Spend per day as bars, with import volume behind them in a lighter shade.
 * The two together are the signal worth watching: volume climbing without
 * spend climbing is fine, spend climbing without volume is not.
 */
export function chart(series) {
  const highest = Math.max(...series.map((d) => d.micros), 0);
  // Guards the division below; a window with no spend at all says nothing
  // rather than reporting a peak of a rounded-away fraction of a cent.
  const peakSpend = Math.max(highest, 1);
  const peakCalls = Math.max(...series.map((d) => d.calls), 1);
  const bars = series.map((d) => {
    const title = `${d.day}: ${money(d.micros)}, ${count(d.calls)} import${d.calls === 1 ? '' : 's'}`;
    return `<span class="bar" title="${esc(title)}">
      <i class="bar-calls" style="height:${(d.calls / peakCalls) * 100}%"></i>
      <i class="bar-spend" style="height:${(d.micros / peakSpend) * 100}%"></i>
    </span>`;
  }).join('');

  return `
    <div class="chart">
      <div class="chart-head">
        <span class="key"><i class="swatch swatch--spend"></i>Spend</span>
        <span class="key"><i class="swatch swatch--calls"></i>Imports</span>
        <span class="chart-peak">${highest ? `peak ${money(highest)} a day` : ''}</span>
      </div>
      <div class="bars">${bars}</div>
      <div class="chart-axis"><span>${esc(series[0]?.day ?? '')}</span><span>${esc(series.at(-1)?.day ?? '')}</span></div>
    </div>`;
}

export function panel(title, note, body) {
  const head = title
    ? `<div class="panel-head"><h3>${esc(title)}</h3>${note ? `<p>${esc(note)}</p>` : ''}</div>`
    : '';
  return `<section class="panel">${head}<div class="scroll">${body}</div></section>`;
}

export function empty(text, span) {
  return `<tr><td colspan="${span}" class="empty">${esc(text)}</td></tr>`;
}

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/cooks', label: 'Cooks' },
  { href: '/settings', label: 'Settings' },
];

export function shell(here, body) {
  const links = NAV.map((n) => (
    `<a href="${n.href}" class="${n.href === here ? 'on' : ''}">${esc(n.label)}</a>`
  )).join('');

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Ruchi</title>
<style>${STYLE}</style>
<script>
  try {
    var saved = localStorage.getItem('theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch (e) {}
  function flipTheme() {
    var root = document.documentElement;
    var dark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (e) {}
  }
</script>
<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="/">Ruchi</a>
    <nav class="tabs">${links}</nav>
    <button class="theme" onclick="flipTheme()" title="Light or dark" aria-label="Switch between light and dark">
      <span class="sun">&#9788;</span><span class="moon">&#9790;</span>
    </button>
  </div>
</header>
<main class="wrap">${body}</main>
`;
}

const DARK = `
    --bg: #121210; --panel: #1B1B18; --ink: #EFEDE6; --muted: #9B968C;
    --line: #2C2C26; --green: #A8C4AE; --deep: #C9DCCE; --wash: #232C26;
    --warn: #E0A07C; --shadow: none;
    --sun: inline; --moon: none;
`;

const STYLE = `
  :root {
    --bg: #FAF9F7; --panel: #FFFFFF; --ink: #241A16; --muted: #6E6A63;
    --line: #E8E5DE; --green: #47624F; --deep: #34483A; --wash: #EDF0EA;
    --warn: #A3502F; --shadow: 0 1px 2px rgba(30,20,10,.04), 0 10px 28px rgba(30,20,10,.045);
    /* Which half of the theme button is showing. Swapped by the dark palette,
       so the button needs no rule of its own per state. */
    --sun: none; --moon: inline;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK} } }
  :root[data-theme="dark"] { ${DARK} }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; background: var(--bg); color: var(--ink);
    -webkit-font-smoothing: antialiased;
  }
  a { color: inherit; }
  .wrap { max-width: 1400px; margin: 0 auto; padding: 0 24px; }

  .top { border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 5; }
  .top-in { display: flex; align-items: center; gap: 26px; height: 56px; }
  .brand { font-weight: 700; font-size: 16px; letter-spacing: -.01em; text-decoration: none; }
  .tabs { display: flex; gap: 4px; }
  .tabs a {
    text-decoration: none; font-size: 14px; font-weight: 550; color: var(--muted);
    padding: 6px 12px; border-radius: 8px;
  }
  .tabs a:hover { background: var(--wash); color: var(--ink); }
  .tabs a.on { background: var(--wash); color: var(--deep); }
  .theme {
    margin-left: auto; padding: 5px 10px; font-size: 15px; line-height: 1;
    background: transparent; color: var(--muted); border-color: transparent;
  }
  .theme:hover { background: var(--wash); color: var(--ink); }
  .theme .sun { display: var(--sun); }
  .theme .moon { display: var(--moon); }

  main { padding: 26px 20px 8px; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -.015em; }
  .lede { margin: 3px 0 0; color: var(--muted); font-size: 13.5px; }
  h2 { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 30px 0 10px; }
  .dim { color: var(--muted); }
  .warn { color: var(--warn); font-weight: 600; }
  .live { color: var(--green); font-weight: 600; }
  .note { font-size: 12px; font-weight: 500; }

  .seg { display: inline-flex; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 3px; gap: 2px; }
  .seg a {
    text-decoration: none; font-size: 13px; font-weight: 550; color: var(--muted);
    padding: 5px 11px; border-radius: 7px; white-space: nowrap;
  }
  .seg a:hover { color: var(--ink); }
  .seg a.on { background: var(--wash); color: var(--deep); }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .stat {
    display: flex; flex-direction: column; gap: 3px; padding: 15px 17px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 13px; box-shadow: var(--shadow);
  }
  .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); font-weight: 650; }
  .stat-big { font-size: 26px; font-weight: 640; letter-spacing: -.025em; font-variant-numeric: tabular-nums; display: flex; align-items: baseline; gap: 8px; }
  .stat-sub { font-size: 12.5px; color: var(--muted); }
  .delta { font-size: 12px; font-weight: 650; letter-spacing: 0; color: var(--muted); }
  .delta--warn { color: var(--warn); }

  .chart { background: var(--panel); border: 1px solid var(--line); border-radius: 13px; padding: 14px 16px 11px; box-shadow: var(--shadow); }
  .chart-head { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--muted); margin-bottom: 11px; }
  .key { display: inline-flex; align-items: center; gap: 5px; }
  .swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
  .swatch--spend { background: var(--green); }
  .swatch--calls { background: var(--wash); border: 1px solid var(--line); }
  .chart-peak { margin-left: auto; font-variant-numeric: tabular-nums; }
  .bars { display: flex; align-items: flex-end; gap: 2px; height: 108px; }
  .bar { position: relative; flex: 1; height: 100%; min-width: 2px; }
  .bar i { position: absolute; bottom: 0; border-radius: 2px 2px 0 0; display: block; }
  /* Volume behind, spend narrower in front, so the two are readable at once. */
  .bar-calls { left: 0; right: 0; background: var(--wash); }
  .bar-spend { left: 22%; right: 22%; background: var(--green); opacity: .92; }
  .bar:hover .bar-calls { background: var(--line); }
  .bar:hover .bar-spend { opacity: 1; }
  .chart-axis { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--muted); margin-top: 7px; font-variant-numeric: tabular-nums; }

  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 13px; overflow: hidden; box-shadow: var(--shadow); }
  .panel + .panel { margin-top: 12px; }
  .panel-head { padding: 14px 17px 2px; }
  .panel-head h3 { margin: 0; font-size: 15px; font-weight: 640; }
  .panel-head p { margin: 3px 0 0; font-size: 13px; color: var(--muted); }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
  .split .panel + .panel { margin-top: 0; }

  /* A table that outgrows the card scrolls inside it, rather than the page
     scrolling sideways or the columns crushing into each other. */
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; min-width: 520px; }
  th, td { text-align: left; padding: 10px 17px; border-top: 1px solid var(--line); }
  thead th {
    border-top: 0; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); font-weight: 700; padding-top: 14px; padding-bottom: 8px;
  }
  .panel-head + .scroll thead th { border-top: 1px solid var(--line); }
  thead th a { color: inherit; text-decoration: none; }
  thead th a:hover { color: var(--ink); }
  thead th a.on { color: var(--deep); }
  td.num, th.num { text-align: right; white-space: nowrap; }
  td.when, th.when { text-align: right; font-size: 12.5px; white-space: nowrap; color: var(--muted); }
  tbody tr:hover { background: color-mix(in srgb, var(--wash) 50%, transparent); }
  td a.who { font-weight: 600; text-decoration: none; border-bottom: 1px solid var(--line); }
  td a.who:hover { border-bottom-color: var(--green); }
  .empty { text-align: center; color: var(--muted); padding: 30px 17px; }

  .tag { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; padding: 2px 9px; border-radius: 999px; background: var(--wash); color: var(--deep); }
  .tag--pro { background: var(--green); color: var(--panel); }
  .tag--trial { background: transparent; color: var(--green); box-shadow: inset 0 0 0 1px var(--green); }
  .grade-note { display: block; font-size: 12px; margin-top: 3px; }
  .range { color: var(--muted); }
  .range::before { content: '·'; margin: 0 6px; }
  .soon { font-size: 11.5px; color: var(--muted); font-style: italic; margin-left: 6px; }

  .filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .filters input[type=search] { min-width: 14em; }
  input, select, button {
    font: inherit; font-size: 13.5px; padding: 6px 10px; border-radius: 9px;
    border: 1px solid var(--line); background: var(--panel); color: inherit;
  }
  button { cursor: pointer; background: var(--green); color: var(--panel); border-color: var(--green); font-weight: 600; padding: 6px 14px; }
  button:hover { opacity: .9; }
  form.set { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  form.set input[type=number] { width: 7em; text-align: right; }
  form.set input.wide { width: 22em; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12.5px; }

  .pager { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 13px; color: var(--muted); }
  .pager a { text-decoration: none; font-weight: 600; color: var(--deep); padding: 5px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .pager a:hover { border-color: var(--green); }
  .pager .off { opacity: .35; pointer-events: none; }

  .back { font-size: 13px; color: var(--muted); text-decoration: none; }
  .back:hover { color: var(--ink); }

  .src { font-size: 12px; margin-left: 8px; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12.5px; }
  main { padding-bottom: 56px; }
  @media (max-width: 720px) {
    .split { grid-template-columns: 1fr; }
    .split .panel + .panel { margin-top: 12px; }
    th, td { padding: 9px 12px; }
    .when, th.when { display: none; }
    .top-in { gap: 14px; }
  }
`;

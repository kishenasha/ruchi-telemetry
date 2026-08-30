/**
 * ruchi-telemetry: the permanent home for ruchi-ai's usage records, and one
 * OWNER-only page that reads them back. See plan/14 section 14.8.
 *
 * Two routes that matter. POST /ingest takes one metadata-only usage record
 * pushed by ruchi-ai's accounting path; GET / renders the dashboard. Nothing
 * here ever receives or stores recipe text, a prompt, a receipt image, or a
 * raw RevenueCat identity: the ingest validator reads a fixed set of known
 * fields and drops everything else on the floor, so a field that should not
 * be here cannot arrive by accident.
 */

const SLUG = /^[a-z0-9_]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A person who somehow reached an AI call without a verified identity still
// gets counted, under a name that cannot collide with a real 64-hex hash.
const NO_IDENTITY = 'anonymous';

const MICROS_PER_USD = 1_000_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return text('ok');
    if (url.pathname === '/robots.txt') return text('User-agent: *\nDisallow: /\n');

    if (url.pathname === '/ingest') {
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      return ingest(request, env);
    }

    if (url.pathname === '/') {
      const denied = requireDashboardAuth(request, env);
      return denied ?? dashboard(url, env);
    }

    return json({ error: 'not found' }, 404);
  },
};

// -- ingest -----------------------------------------------------------------

async function ingest(request, env) {
  if (!env.INGEST_SECRET) return json({ error: 'not configured' }, 503);
  const offered = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!sameSecret(offered, env.INGEST_SECRET)) return json({ error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const record = readRecord(body);
  if (!record) return json({ error: 'bad record' }, 400);

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO usage_daily (
      day, user_hash, feature_id, plan,
      request_count, error_count, cost_usd_micros, cost_known_count,
      input_tokens, output_tokens, latency_ms_total, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (day, user_hash, feature_id, plan) DO UPDATE SET
      request_count    = request_count + 1,
      error_count      = error_count + excluded.error_count,
      cost_usd_micros  = cost_usd_micros + excluded.cost_usd_micros,
      cost_known_count = cost_known_count + excluded.cost_known_count,
      input_tokens     = input_tokens + excluded.input_tokens,
      output_tokens    = output_tokens + excluded.output_tokens,
      latency_ms_total = latency_ms_total + excluded.latency_ms_total,
      last_seen        = excluded.last_seen
  `).bind(
    record.day, record.userHash, record.featureId, record.plan,
    record.errored, record.costMicros, record.costKnown,
    record.inputTokens, record.outputTokens, record.latencyMs, now, now,
  ).run();

  return json({ ok: true });
}

/**
 * Reads only the fields this service is allowed to hold, from ruchi-ai's
 * UsageRecord shape. Returns null when something required is missing or
 * malformed; anything unrecognized in the body is ignored rather than stored.
 */
export function readRecord(body) {
  if (!body || typeof body !== 'object') return null;

  const featureId = body.feature_id;
  const plan = body.plan;
  if (!SLUG.test(featureId || '') || !SLUG.test(plan || '')) return null;

  const rawHash = body.user_hash;
  if (rawHash != null && !HEX64.test(rawHash)) return null;

  // The record's own timestamp decides which day it lands on, so a record
  // pushed either side of midnight UTC still counts on the day it happened.
  const day = dayOf(body.timestamp);
  if (!day) return null;

  const costKnown = body.cost_known === true;
  const costMicros = costKnown ? whole(body.cost_usd_micros) : 0;

  return {
    day,
    userHash: rawHash ?? NO_IDENTITY,
    featureId,
    plan,
    errored: body.status === 'ok' ? 0 : 1,
    costMicros,
    costKnown: costKnown ? 1 : 0,
    inputTokens: whole(body.input_tokens),
    outputTokens: whole(body.output_tokens),
    latencyMs: whole(body.latency_ms),
  };
}

function whole(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function dayOf(timestamp) {
  // Seconds since epoch, as ruchi-ai's time.time() produces.
  const ms = Number.isFinite(timestamp) ? timestamp * 1000 : Date.now();
  const iso = new Date(ms).toISOString().slice(0, 10);
  return DAY.test(iso) ? iso : null;
}

// -- dashboard --------------------------------------------------------------

const WINDOWS = [
  { key: 'today', label: 'Today', days: 1 },
  { key: 'week', label: '7 days', days: 7 },
  { key: 'month', label: '30 days', days: 30 },
  { key: 'all', label: 'All time', days: null },
];

async function dashboard(url, env) {
  const chosen = WINDOWS.find((w) => w.key === url.searchParams.get('w')) ?? WINDOWS[2];

  const [cards, features, people] = await Promise.all([
    Promise.all(WINDOWS.map(async (w) => ({ ...w, totals: await totals(env, w.days) }))),
    breakdown(env, chosen.days, 'feature_id'),
    breakdown(env, chosen.days, 'user_hash'),
  ]);

  return html(page(chosen, cards, features, people));
}

function since(days) {
  const from = new Date(Date.now() - (days - 1) * 86400000);
  return from.toISOString().slice(0, 10);
}

async function totals(env, days) {
  const columns = `
    COALESCE(SUM(request_count), 0)    AS calls,
    COALESCE(SUM(cost_usd_micros), 0)  AS micros,
    COALESCE(SUM(cost_known_count), 0) AS priced,
    COALESCE(SUM(error_count), 0)      AS errors
  `;
  const statement = days === null
    ? env.DB.prepare(`SELECT ${columns} FROM usage_daily`)
    : env.DB.prepare(`SELECT ${columns} FROM usage_daily WHERE day >= ?`).bind(since(days));
  return (await statement.first()) ?? { calls: 0, micros: 0, priced: 0, errors: 0 };
}

async function breakdown(env, days, column) {
  const columns = `
    ${column} AS name,
    COALESCE(SUM(request_count), 0)    AS calls,
    COALESCE(SUM(cost_usd_micros), 0)  AS micros,
    COALESCE(SUM(cost_known_count), 0) AS priced,
    COALESCE(SUM(error_count), 0)      AS errors,
    MAX(last_seen)                     AS seen
  `;
  const tail = `GROUP BY ${column} ORDER BY micros DESC, calls DESC LIMIT 100`;
  const statement = days === null
    ? env.DB.prepare(`SELECT ${columns} FROM usage_daily ${tail}`)
    : env.DB.prepare(`SELECT ${columns} FROM usage_daily WHERE day >= ? ${tail}`).bind(since(days));
  const { results } = await statement.all();
  return results ?? [];
}

// -- rendering --------------------------------------------------------------

function money(micros) {
  const usd = (micros || 0) / MICROS_PER_USD;
  if (usd === 0) return '$0';
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function count(n) {
  return (n || 0).toLocaleString('en-US');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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

// Spend is only as complete as the provider's own cost reporting, so a window
// holding calls whose cost never came back says so rather than implying the
// total is the whole story.
function pricedNote(row) {
  const missing = (row.calls || 0) - (row.priced || 0);
  return missing > 0 ? `<span class="warn">${count(missing)} unpriced</span>` : '';
}

function rows(list, nameOf) {
  if (!list.length) return '<tr><td colspan="5" class="empty">Nothing recorded yet.</td></tr>';
  return list.map((row) => `
    <tr>
      <td class="name">${nameOf(row)}</td>
      <td>${count(row.calls)}</td>
      <td>${money(row.micros)} ${pricedNote(row)}</td>
      <td>${row.errors ? `<span class="warn">${count(row.errors)}</span>` : '0'}</td>
      <td class="dim">${esc((row.seen || '').slice(0, 16).replace('T', ' '))}</td>
    </tr>
  `).join('');
}

function page(chosen, cards, features, people) {
  const tabs = WINDOWS.map((w) => (
    `<a class="${w.key === chosen.key ? 'on' : ''}" href="?w=${w.key}">${w.label}</a>`
  )).join('');

  const summary = cards.map((c) => `
    <div class="card">
      <h2>${c.label}</h2>
      <p class="big">${money(c.totals.micros)}</p>
      <p class="dim">${count(c.totals.calls)} calls ${pricedNote(c.totals)}</p>
    </div>
  `).join('');

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Ruchi AI spend</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px; max-width: 900px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; opacity: .6; margin: 0 0 6px; }
  h3 { font-size: 15px; margin: 28px 0 8px; }
  .dim { opacity: .6; }
  .warn { color: #b45309; }
  .sub { margin: 0 0 20px; opacity: .6; font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .card { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; padding: 12px 14px; }
  .big { font-size: 22px; margin: 0 0 2px; font-variant-numeric: tabular-nums; }
  .card p { margin: 0; font-size: 13px; }
  nav { margin: 24px 0 4px; display: flex; gap: 6px; flex-wrap: wrap; }
  nav a { padding: 4px 10px; border: 1px solid rgba(128,128,128,.3); border-radius: 999px; text-decoration: none; color: inherit; font-size: 13px; }
  nav a.on { background: rgba(128,128,128,.18); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,.18); }
  th:first-child, td:first-child { text-align: left; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; font-weight: 600; }
  .name { font-family: ui-monospace, monospace; font-size: 13px; }
  .empty { text-align: center; opacity: .5; padding: 18px; }
  .foot { margin-top: 32px; font-size: 12px; opacity: .55; }
</style>
<h1>Ruchi AI spend</h1>
<p class="sub">Metadata only. No recipes, prompts, or real identities are stored here.</p>

<div class="cards">${summary}</div>

<nav>${tabs}</nav>
<p class="dim" style="font-size:13px;margin:0">Tables below cover ${esc(chosen.label.toLowerCase())}.</p>

<h3>By feature</h3>
<table>
  <tr><th>Feature</th><th>Calls</th><th>Spend</th><th>Errors</th><th>Last seen</th></tr>
  ${rows(features, (r) => esc(r.name))}
</table>

<h3>By person</h3>
<table>
  <tr><th>Person</th><th>Calls</th><th>Spend</th><th>Errors</th><th>Last seen</th></tr>
  ${rows(people, (r) => `<span title="${esc(r.name)}">${esc(nickname(r.name))}</span>`)}
</table>

<p class="foot">Times UTC. Spend is what the provider reported; unpriced calls are counted but add nothing to a total.</p>
`;
}

// -- plumbing ---------------------------------------------------------------

function requireDashboardAuth(request, env) {
  if (!env.DASHBOARD_PASSWORD) return json({ error: 'not configured' }, 503);

  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const decoded = safeAtob(header.slice(6));
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (decoded.includes(':') && sameSecret(password, env.DASHBOARD_PASSWORD)) return null;
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Ruchi telemetry", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function safeAtob(value) {
  try {
    return atob(value);
  } catch {
    return '';
  }
}

// Length-independent comparison, so a wrong guess reveals nothing by timing.
export function sameSecret(offered, expected) {
  if (typeof offered !== 'string' || typeof expected !== 'string') return false;
  const a = new TextEncoder().encode(offered);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE },
  });
}

function html(body) {
  return new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE },
  });
}

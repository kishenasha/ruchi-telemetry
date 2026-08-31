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
      if (denied) return denied;
      if (request.method === 'POST') return saveSetting(request, env);
      return dashboard(url, env);
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

// -- limits -----------------------------------------------------------------

// Kept in step with lib/quota.py's DEFAULT_LIMITS by hand. These are what the
// services fall back to, so the dashboard shows them as the live policy until
// something overrides them.
const TIERS = [
  { feature: 'smart_import', plan: 'free', max: 10, period: 'month' },
  { feature: 'smart_import', plan: 'pro', max: 6000, period: 'month' },
  // Settable already so the numbers are agreed before the features land.
  { feature: 'text_import', plan: 'free', max: 5, period: 'life', built: false },
  { feature: 'text_import', plan: 'pro', max: 6000, period: 'month', built: false },
  { feature: 'image_import', plan: 'free', max: 3, period: 'life', built: false },
  { feature: 'image_import', plan: 'pro', max: 6000, period: 'month', built: false },
];

// The ids are terse and three of the four are some kind of import, so the
// table says which is which rather than making you remember.
const FEATURE_LABEL = {
  smart_import: 'Recipe URL',
  text_import: 'Pasted text',
  image_import: 'Photo',
};

// Which model each plan's imports run on. The whole difference between the
// tiers: a free import is tidied by the cheap one and opens in the editor to
// confirm, a Pro import is reconstructed by the good one and saves itself.
// Kept in step with server/lib/models.py's DEFAULT_MODELS by hand.
const MODELS = [
  { plan: 'free', model: 'google/gemini-2.5-flash-lite' },
  { plan: 'pro', model: 'openai/gpt-5.6-luna' },
];

// Same rule server side. A value that fails it is refused here rather than
// saved and silently ignored by the services.
export const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;

async function readModels(env) {
  const { results } = await env.DB.prepare('SELECT * FROM models').all();
  const saved = new Map((results ?? []).map((r) => [r.plan, r]));
  return MODELS.map((tier) => {
    const row = saved.get(tier.plan);
    return row
      ? {
        ...tier,
        model: row.model,
        applied: row.applied === 1,
        updatedAt: row.updated_at,
        custom: true,
      }
      : { ...tier, applied: true, updatedAt: null, custom: false };
  });
}

async function saveModel(env, form) {
  const plan = String(form.get('plan') ?? '');
  const model = String(form.get('model') ?? '').trim();
  if (!MODELS.some((m) => m.plan === plan)) return 'unknown plan';
  if (!MODEL_ID.test(model)) return 'not a model id';

  const applied = await pushModelToUpstash(env, plan, model);
  await env.DB.prepare(`
    INSERT INTO models (plan, model, applied, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (plan) DO UPDATE SET
      model = excluded.model, applied = excluded.applied, updated_at = excluded.updated_at
  `).bind(plan, model, applied ? 1 : 0, new Date().toISOString()).run();
  return null;
}

async function pushModelToUpstash(env, plan, model) {
  if (!env.UPSTASH_URL || !env.UPSTASH_TOKEN) return false;
  try {
    const response = await fetch(`${env.UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([['SET', `model:${plan}`, model]]),
    });
    return response.ok;
  } catch {
    return false;
  }
}
const PERIODS = ['day', 'month', 'year', 'life'];

async function readLimits(env) {
  const { results } = await env.DB.prepare('SELECT * FROM limits').all();
  const saved = new Map((results ?? []).map((r) => [`${r.feature_id}:${r.plan}`, r]));
  return TIERS.map((tier) => {
    const row = saved.get(`${tier.feature}:${tier.plan}`);
    return row
      ? {
        ...tier,
        max: row.max_calls,
        period: row.period,
        applied: row.applied === 1,
        updatedAt: row.updated_at,
        custom: true,
      }
      : { ...tier, applied: true, updatedAt: null, custom: false };
  });
}

// Enforcement reads Upstash, which both services already call on every
// request, so a changed limit takes effect without either being redeployed.
async function pushToUpstash(env, feature, plan, max, period) {
  if (!env.UPSTASH_URL || !env.UPSTASH_TOKEN) return false;
  try {
    const response = await fetch(`${env.UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([['SET', `limit:${feature}:${plan}`, `${max}:${period}`]]),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function saveSetting(request, env) {
  // Basic auth is sent automatically by the browser for its realm, so a POST
  // from another origin would otherwise carry it too. Cheap to refuse.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'origin' }, 403);

  const form = await request.formData();

  // Two settings share this endpoint because they share the shape: validate,
  // push to Upstash, record whether it landed.
  if (form.get('model') !== null) {
    const failure = await saveModel(env, form);
    if (failure) return json({ error: failure }, 400);
    return Response.redirect(new URL(request.url).origin + '/', 303);
  }

  const feature = String(form.get('feature') ?? '');
  const plan = String(form.get('plan') ?? '');
  const period = String(form.get('period') ?? '');
  const max = Number(form.get('max'));

  const known = TIERS.some((t) => t.feature === feature && t.plan === plan);
  const valid = known && PERIODS.includes(period)
    && Number.isInteger(max) && max >= 0 && max <= 1_000_000;
  if (!valid) return json({ error: 'bad limit' }, 400);

  // Pushed first: the stored row records whether enforcement actually has it,
  // so the page can never show a limit as live when it is not.
  const applied = await pushToUpstash(env, feature, plan, max, period);
  await env.DB.prepare(`
    INSERT INTO limits (feature_id, plan, max_calls, period, applied, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (feature_id, plan) DO UPDATE SET
      max_calls = excluded.max_calls,
      period = excluded.period,
      applied = excluded.applied,
      updated_at = excluded.updated_at
  `).bind(feature, plan, max, period, applied ? 1 : 0, new Date().toISOString()).run();

  return new Response(null, { status: 303, headers: { Location: '/', ...NO_STORE } });
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

  const [cards, features, plans, people, limits, models] = await Promise.all([
    Promise.all(WINDOWS.map(async (w) => ({ ...w, totals: await totals(env, w.days) }))),
    breakdown(env, chosen.days, 'feature_id'),
    breakdown(env, chosen.days, 'plan'),
    peopleBreakdown(env, chosen.days),
    readLimits(env),
    readModels(env),
  ]);

  return html(page(chosen, cards, features, plans, people, limits, models));
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

// Grouped by person and tier together rather than by person alone: a cook who
// upgraded mid-window has spend on both sides of the paywall, and collapsing
// that would hide the one number the tiers exist to answer.
async function peopleBreakdown(env, days) {
  const columns = `
    user_hash AS name,
    plan,
    COALESCE(SUM(request_count), 0)    AS calls,
    COALESCE(SUM(cost_usd_micros), 0)  AS micros,
    COALESCE(SUM(cost_known_count), 0) AS priced,
    COALESCE(SUM(error_count), 0)      AS errors,
    MAX(last_seen)                     AS seen
  `;
  const tail = 'GROUP BY user_hash, plan ORDER BY micros DESC, calls DESC LIMIT 100';
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
  return missing > 0 ? ` <span class="warn note">${count(missing)} unpriced</span>` : '';
}

function planTag(plan) {
  const label = plan === 'pro' ? 'Pro' : plan === 'free' ? 'Free' : (plan || 'unknown');
  return `<span class="tag${plan === 'pro' ? ' tag--pro' : ''}">${esc(label)}</span>`;
}

// The id is what the services use; nobody reading this needs to see it.
function featureName(id) {
  return `<strong>${esc(FEATURE_LABEL[id] ?? id)}</strong>`;
}

function rows(list, nameOf, { withPlan = false, empty = 'Nothing yet.' } = {}) {
  const width = withPlan ? 6 : 5;
  if (!list.length) return `<tr><td colspan="${width}" class="empty">${esc(empty)}</td></tr>`;
  return list.map((row) => `
    <tr>
      <td>${nameOf(row)}</td>
      ${withPlan ? `<td>${planTag(row.plan)}</td>` : ''}
      <td class="num">${count(row.calls)}</td>
      <td class="num">${money(row.micros)}${pricedNote(row)}</td>
      <td class="num">${failures(row)}</td>
      <td class="dim when">${esc((row.seen || '').slice(0, 16).replace('T', ' '))}</td>
    </tr>
  `).join('');
}

// A bare red digit says nothing about how bad it is. Out of how many does.
function failures(row) {
  if (!row.errors) return '<span class="ok-dot">none</span>';
  return `<span class="warn">${count(row.errors)} of ${count(row.calls)}</span>`;
}

const PERIOD_LABEL = {
  day: 'a day', month: 'a month', year: 'a year', life: 'for the life of the install',
};

function modelRows(models) {
  return models.map((m) => `
    <tr>
      <td>${planTag(m.plan)}</td>
      <td class="dim">${m.plan === 'pro'
        ? 'Reconstructs the recipe and saves it, no editor'
        : 'Tidies the recipe, then the cook confirms it'}</td>
      <td>
        <form method="post" class="set">
          <input type="hidden" name="plan" value="${esc(m.plan)}">
          <input type="text" name="model" value="${esc(m.model)}" class="wide"
                 pattern="[a-z0-9][a-z0-9._\-]*/[a-z0-9][a-z0-9._:\-]*" required>
          <button type="submit">Save</button>
        </form>
      </td>
      <td>${state(m)}</td>
    </tr>
  `).join('');
}

// Whether what is shown is actually what the services are enforcing.
function state(row) {
  if (!row.custom) return '<span class="dim">shipped default</span>';
  return row.applied
    ? '<span class="ok-dot">live</span>'
    : '<span class="warn">not applied</span>';
}

function limitRows(limits) {
  return limits.map((l) => `
    <tr>
      <td>${featureName(l.feature)}${l.built === false ? ' <span class="soon">not built yet</span>' : ''}</td>
      <td>${planTag(l.plan)}</td>
      <td>
        <form method="post" class="set">
          <input type="hidden" name="feature" value="${esc(l.feature)}">
          <input type="hidden" name="plan" value="${esc(l.plan)}">
          <input type="number" name="max" value="${l.max}" min="0" max="1000000" required>
          <select name="period">
            ${PERIODS.map((p) => `<option value="${p}"${p === l.period ? ' selected' : ''}>${PERIOD_LABEL[p]}</option>`).join('')}
          </select>
          <button type="submit">Save</button>
        </form>
      </td>
      <td>${state(l)}</td>
    </tr>
  `).join('');
}

function page(chosen, cards, features, plans, people, limits, models) {
  // The cards are the window selector. Two rows both offering today/7/30/all
  // was the same choice asked twice.
  const summary = cards.map((c) => `
    <a class="card ${c.key === chosen.key ? 'on' : ''}" href="?w=${c.key}">
      <span class="card-label">${esc(c.label)}</span>
      <span class="card-big">${money(c.totals.micros)}</span>
      <span class="card-sub">${count(c.totals.calls)} ${c.totals.calls === 1 ? 'import' : 'imports'}</span>
    </a>
  `).join('');

  const totals = cards.find((c) => c.key === chosen.key)?.totals ?? { calls: 0, errors: 0, micros: 0 };
  const worked = (totals.calls || 0) - (totals.errors || 0);
  const perCall = totals.calls ? money(Math.round((totals.micros || 0) / totals.calls)) : null;
  const headline = totals.calls
    ? `${count(worked)} of ${count(totals.calls)} imports worked${perCall ? `, averaging ${perCall} each` : ''}.`
    : 'No imports in this period yet.';

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Ruchi</title>
<style>
  :root {
    --bg: #FAFAF9; --panel: #FFFFFF; --ink: #2A1A1F; --muted: #6B6B66;
    --line: #E7E7E2; --green: #47624F; --wash: #ECEFE9; --warn: #A3502F;
    --shadow: 0 1px 2px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14140F; --panel: #1D1D18; --ink: #EDEDE6; --muted: #9A9A92;
      --line: #2E2E27; --green: #A8C4AE; --wash: #26302A; --warn: #E0A07C;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 28px 20px 64px; background: var(--bg); color: var(--ink);
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  header { margin-bottom: 22px; }
  h1 { font-size: 21px; margin: 0; letter-spacing: -.01em; }
  .sub { margin: 3px 0 0; color: var(--muted); font-size: 13.5px; }
  h2 {
    font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .07em; color: var(--muted); margin: 34px 0 10px;
  }
  .dim { color: var(--muted); }
  .warn { color: var(--warn); font-weight: 600; }
  .note { font-size: 12px; font-weight: 500; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .card {
    display: flex; flex-direction: column; gap: 2px; padding: 13px 15px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    text-decoration: none; color: inherit; box-shadow: var(--shadow);
    transition: border-color .12s, transform .12s;
  }
  .card:hover { border-color: var(--green); }
  .card.on { border-color: var(--green); box-shadow: 0 0 0 1px var(--green), var(--shadow); }
  .card-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; }
  .card-big { font-size: 24px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .card-sub { font-size: 12.5px; color: var(--muted); }

  .headline { margin: 16px 0 0; font-size: 14.5px; color: var(--muted); }
  .headline strong { color: var(--ink); font-weight: 650; }

  .panel {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; overflow: hidden; box-shadow: var(--shadow);
  }
  .panel + .panel { margin-top: 12px; }
  .panel-head { padding: 13px 16px 0; }
  .panel-head h3 { margin: 0; font-size: 15px; font-weight: 650; }
  .panel-head p { margin: 3px 0 0; font-size: 13px; color: var(--muted); }

  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 10px 16px; border-top: 1px solid var(--line); }
  thead th {
    border-top: 0; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
    color: var(--muted); font-weight: 700; padding-top: 14px; padding-bottom: 8px;
  }
  .panel-head + table thead th { border-top: 1px solid var(--line); margin-top: 10px; }
  td.num, th.num { text-align: right; }
  td.when, th.when { text-align: right; font-size: 12.5px; white-space: nowrap; }
  tbody tr:hover { background: color-mix(in srgb, var(--wash) 55%, transparent); }
  .empty { text-align: center; color: var(--muted); padding: 26px 16px; }

  .tag {
    display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .04em;
    padding: 2px 9px; border-radius: 999px; background: var(--wash); color: var(--green);
  }
  .tag--pro { background: var(--green); color: var(--panel); }
  .ok-dot { color: var(--muted); }
  .soon { font-size: 11.5px; color: var(--muted); font-style: italic; margin-left: 6px; }

  form.set { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  form.set input, form.set select, form.set button {
    font: inherit; font-size: 13.5px; padding: 6px 9px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--bg); color: inherit;
  }
  form.set input[type=number] { width: 5.5em; text-align: right; }
  form.set input.wide { width: 15em; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12.5px; }
  form.set button {
    cursor: pointer; background: var(--green); color: var(--panel);
    border-color: var(--green); font-weight: 600; padding: 6px 14px;
  }
  form.set button:hover { opacity: .88; }

  .foot { margin-top: 30px; font-size: 12.5px; color: var(--muted); }
  @media (max-width: 640px) {
    th, td { padding: 9px 11px; }
    .when, th.when { display: none; }
  }
</style>
<div class="wrap">

<header>
  <h1>Ruchi</h1>
  <p class="sub">What imports are costing. Metadata only, no recipes or real identities.</p>
</header>

<div class="cards">${summary}</div>
<p class="headline">${headline}</p>

<h2>Where it went</h2>

<div class="panel">
  <table>
    <thead><tr><th>Import type</th><th class="num">Imports</th><th class="num">Spend</th><th class="num">Failed</th><th class="when">Last one</th></tr></thead>
    <tbody>${rows(features, (r) => featureName(r.name), { empty: `No imports in the last ${esc(chosen.label.toLowerCase())}.` })}</tbody>
  </table>
</div>

<div class="panel">
  <table>
    <thead><tr><th>Membership</th><th class="num">Imports</th><th class="num">Spend</th><th class="num">Failed</th><th class="when">Last one</th></tr></thead>
    <tbody>${rows(plans, (r) => planTag(r.name), { empty: 'Nothing to split by membership yet.' })}</tbody>
  </table>
</div>

<div class="panel">
  <table>
    <thead><tr><th>Cook</th><th>Plan</th><th class="num">Imports</th><th class="num">Spend</th><th class="num">Failed</th><th class="when">Last one</th></tr></thead>
    <tbody>${rows(people, (r) => `<span title="${esc(r.name)}">${esc(nickname(r.name))}</span>`, { withPlan: true, empty: 'No cooks have imported yet.' })}</tbody>
  </table>
</div>
<p class="dim" style="font-size:12.5px;margin:8px 2px 0">
  Names are made up from a one-way code. There is no way back to a person from here.
</p>

<h2>Settings</h2>

<div class="panel">
  <div class="panel-head">
    <h3>Which model each membership uses</h3>
    <p>This is the whole difference between Free and Pro. Changes apply within seconds, with no app release.</p>
  </div>
  <table>
    <thead><tr><th>Membership</th><th>What it does</th><th>Model</th><th>State</th></tr></thead>
    <tbody>${modelRows(models)}</tbody>
  </table>
</div>

<div class="panel">
  <div class="panel-head">
    <h3>How many imports each membership gets</h3>
    <p>Per import type and membership, never per person. Zero turns that combination off entirely.</p>
  </div>
  <table>
    <thead><tr><th>Import type</th><th>Membership</th><th>Allowance</th><th>State</th></tr></thead>
    <tbody>${limitRows(limits)}</tbody>
  </table>
</div>

<p class="foot">
  Times are UTC. Spend is what the provider reported; a call it did not price is
  counted but adds nothing to a total.
</p>
</div>
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

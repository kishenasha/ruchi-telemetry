/**
 * ruchi-telemetry: the permanent home for ruchi-ai's usage records, and the
 * OWNER-only pages that read them back. See plan/14 section 14.8.
 *
 * POST /ingest takes one metadata-only usage record pushed by ruchi-ai's
 * accounting path; everything else is the dashboard. Nothing here ever
 * receives or stores recipe text, a prompt, a receipt image, or a raw
 * RevenueCat identity: the ingest validator reads a fixed set of known fields
 * and drops everything else on the floor, so a field that should not be here
 * cannot arrive by accident.
 */

import { NO_IDENTITY } from './page.js';
import { saveSetting } from './settings.js';
import * as views from './views.js';

const SLUG = /^[a-z0-9_]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A class name from ruchi-ai, optionally with an HTTP status: HTTPError:429.
// Anything that does not match this shape is dropped rather than stored, so a
// message or a fragment of a page can never arrive by being added upstream.
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}(:\d{1,3})?$/;

export { nickname } from './page.js';
export { MODEL_ID } from './settings.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return text('ok');
    if (url.pathname === '/robots.txt') return text('User-agent: *\nDisallow: /\n');

    if (url.pathname === '/ingest') {
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      return ingest(request, env);
    }

    const denied = requireDashboardAuth(request, env);
    if (denied) return denied;

    if (url.pathname === '/') return html(await views.overview(url, env));

    if (url.pathname === '/cooks') {
      const id = url.searchParams.get('id');
      if (id) {
        if (!HEX64.test(id) && id !== NO_IDENTITY) return json({ error: 'not found' }, 404);
        return html(await views.oneCook(url, env, id));
      }
      return html(await views.cooks(url, env));
    }

    if (url.pathname === '/settings') {
      if (request.method !== 'POST') return html(await views.settings(env));

      // Basic auth is sent automatically by the browser for its realm, so a
      // POST from another origin would otherwise carry it too.
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'origin' }, 403);

      const failure = await saveSetting(env, await request.formData());
      if (failure) return html(await views.settings(env, failure), 400);
      return new Response(null, { status: 303, headers: { Location: '/settings', ...NO_STORE } });
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

  if (record.errorClass) {
    await env.DB.prepare(`
      INSERT INTO errors_daily (day, feature_id, plan, error_class, count, first_seen, last_seen)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (day, feature_id, plan, error_class) DO UPDATE SET
        count = count + 1, last_seen = excluded.last_seen
    `).bind(record.day, record.featureId, record.plan, record.errorClass, now, now).run();
  }

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
    // Only on a call that actually failed, and only in the shape above. The
    // type check is not decoration: RegExp.test stringifies what it is given,
    // so an object with the right toString would pass and then be stored as
    // the object.
    errorClass: body.status !== 'ok' && typeof body.error_class === 'string'
      && ERROR_CLASS.test(body.error_class)
      ? body.error_class
      : null,
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

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE },
  });
}

/**
 * The two things this dashboard can change: which model each membership runs
 * on, and how many imports each membership gets. Both are enforced from
 * Upstash, which ruchi-ai reads on every request, so a change takes effect in
 * seconds without a redeploy. D1 holds the durable record of what was set and
 * whether the push actually landed.
 */

// Kept in step with lib/quota.py's DEFAULT_LIMITS by hand.
//
// Two memberships: every source has a trial row and a pro row, nothing else.
export const SOURCES = [
  { source: 'url', label: 'Recipe URL' },
  { source: 'text', label: 'Pasted text' },
  { source: 'image', label: 'Photo' },
];

export const TIERS = [
  { source: 'url', feature: 'smart_import', plan: 'trial', max: 40, period: 'day' },
  { source: 'url', feature: 'smart_import', plan: 'pro', max: 6000, period: 'month' },
  { source: 'text', feature: 'text_import', plan: 'trial', max: 20, period: 'day' },
  { source: 'text', feature: 'text_import', plan: 'pro', max: 6000, period: 'month' },
  { source: 'image', feature: 'image_import', plan: 'trial', max: 15, period: 'day' },
  { source: 'image', feature: 'image_import', plan: 'pro', max: 6000, period: 'month' },
];

// Kept in step with server/lib/models.py's DEFAULT_MODELS by hand. A trial keeps
// its own row despite shipping on the same model, so the two can be moved apart.
export const MODELS = [
  { source: 'url', feature: 'smart_import', plan: 'trial', model: 'openai/gpt-5.6-luna' },
  { source: 'url', feature: 'smart_import', plan: 'pro', model: 'openai/gpt-5.6-luna' },
  { source: 'text', feature: 'text_import', plan: 'trial', model: 'openai/gpt-5.6-luna' },
  { source: 'text', feature: 'text_import', plan: 'pro', model: 'openai/gpt-5.6-luna' },
  { source: 'image', feature: 'image_import', plan: 'trial', model: 'openai/gpt-5.6-luna' },
  { source: 'image', feature: 'image_import', plan: 'pro', model: 'openai/gpt-5.6-luna' },
];

// Free is kept only for reading back records from before the trial replaced it.
export const PLAN_LABEL = { trial: 'Trial', free: 'Free', pro: 'Pro' };

export const PLAN_NOTE = {
  trial: 'Pro for a while: the same model, saving without the editor, nothing locked',
  free: 'Retired, kept for reading back what happened before the trial replaced it',
  pro: 'What Pro buys, and a ceiling no real cook reaches',
};

// Which source a usage row belongs to, for a table grouped the way a cook
// experiences it rather than the way the server names it.
export const SOURCE_OF = {
  smart_import: 'url', quick_import: 'url', text_import: 'text', image_import: 'image',
};

export const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.source, s.label]));

/**
 * Which membership a cook is on now, read off their most recent usage rather
 * than stored: a cook who upgraded has Pro rows newer than their trial ones.
 *
 * Shared because a cook row carries no plan column of its own, only the tiers
 * nested inside it. Overview and Cooks each derived this once and one of them
 * was missed, which is how the plan came out as "unknown".
 */
export function currentPlan(cook) {
  // tiers arrive newest first, so the first membership named is the current one.
  const tier = (cook?.tiers ?? [])[0];
  return tier ? tier.plan : 'trial';
}

/** Every membership a cook has been on, newest first, each named once. */
export function planHistory(cook) {
  const seen = [];
  for (const tier of cook?.tiers ?? []) {
    if (!seen.includes(tier.plan)) seen.push(tier.plan);
  }
  return seen;
}

export const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;

export const PERIODS = ['day', 'month', 'year', 'life'];

export const PERIOD_LABEL = {
  day: 'a day', month: 'a month', year: 'a year', life: 'for the life of the install',
};

export async function readModels(env) {
  const { results } = await env.DB.prepare('SELECT * FROM models').all();
  const saved = new Map((results ?? []).map((r) => [`${r.feature_id}:${r.plan}`, r]));
  return MODELS.map((tier) => {
    const row = saved.get(`${tier.feature}:${tier.plan}`);
    return row
      ? { ...tier, model: row.model, applied: row.applied === 1, updatedAt: row.updated_at, custom: true }
      : { ...tier, applied: true, updatedAt: null, custom: false };
  });
}

/**
 * How many imports one cook may run in a row before the brake comes on.
 *
 * One number for every import, not one per source: a loop is a loop whether
 * it is firing URLs or photographs. The window it counts over lives in the
 * server and is not settable, so it is named here only to be shown.
 *
 * Stored in `limits` under a reserved feature id rather than in a table of
 * its own. It is not a membership allowance and never appears among them:
 * readLimits() maps over TIERS, which this is deliberately not in.
 */
export const BURST = {
  feature: 'burst', plan: 'all', key: 'limit:burst', max: 5, windowLabel: 'in 10 minutes',
};

/**
 * How long a trial runs, and how long before it ends Ruchi says so. Zero is a
 * real answer for both: no trial at all, and no warning.
 *
 * Kept in the limits table under reserved feature ids, as BURST is.
 */
export const TRIAL_CLOCK = [
  {
    feature: 'trial', plan: 'hours', key: 'trial:hours', max: 24, max_allowed: 8760,
    label: 'How long a trial runs', unit: 'hours',
  },
  {
    feature: 'trial', plan: 'warn_hours', key: 'trial:warn_hours', max: 6, max_allowed: 8760,
    label: 'Warn this long before it ends', unit: 'hours',
  },
];

export async function readTrialClock(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM limits WHERE feature_id = ?',
  ).bind('trial').all();
  const saved = new Map((results ?? []).map((r) => [r.plan, r]));
  return TRIAL_CLOCK.map((dial) => {
    const row = saved.get(dial.plan);
    return row
      ? { ...dial, max: row.max_calls, applied: row.applied === 1, updatedAt: row.updated_at, custom: true }
      : { ...dial, applied: true, updatedAt: null, custom: false };
  });
}

// Keys nothing reads now. Left in Upstash a stale one would silently override a
// shipped default with nothing on this page to show it.
export const RETIRED = {
  keys: [
    'limit:quick_import:free', 'limit:smart_import:free', 'limit:text_import:free',
    'limit:image_import:free', 'limit:free_import:free',
    'model:quick_import:free', 'model:smart_import:free', 'model:text_import:free',
    'model:image_import:free', 'model:free_import:free',
  ],
  features: ['quick_import', 'free_import'],
  plans: ['free'],
};

// ruchi-ai floors whatever it reads, since the brake fails closed and a zero
// would refuse every import for everyone. The form refuses it first, so the
// number shown is always the number enforced.
export const MIN_BURST = 3;

// The toggle turns a combination off, so the number itself never means "none".
export const MIN_ALLOWANCE = 1;

export async function readBurst(env) {
  const row = await env.DB.prepare('SELECT * FROM limits WHERE feature_id = ? AND plan = ?')
    .bind(BURST.feature, BURST.plan).first();
  return row
    ? {
      ...BURST, max: row.max_calls, applied: row.applied === 1, updatedAt: row.updated_at, custom: true,
    }
    : { ...BURST, applied: true, updatedAt: null, custom: false };
}

export async function readLimits(env) {
  const { results } = await env.DB.prepare('SELECT * FROM limits').all();
  const saved = new Map((results ?? []).map((r) => [`${r.feature_id}:${r.plan}`, r]));
  return TIERS.map((tier) => {
    const row = saved.get(`${tier.feature}:${tier.plan}`);
    return row
      ? {
        ...tier,
        max: row.max_calls,
        period: row.period,
        enabled: row.enabled !== 0,
        applied: row.applied === 1,
        updatedAt: row.updated_at,
        custom: true,
      }
      : { ...tier, enabled: true, applied: true, updatedAt: null, custom: false };
  });
}

async function send(env, commands) {
  if (!env.UPSTASH_URL || !env.UPSTASH_TOKEN || !commands.length) return false;
  try {
    const response = await fetch(`${env.UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const push = (env, key, value) => send(env, [['SET', key, value]]);

/** Like send, but hands back what the store answered. */
async function ask(env, commands) {
  if (!env.UPSTASH_URL || !env.UPSTASH_TOKEN || !commands.length) return null;
  try {
    const response = await fetch(`${env.UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function saveModel(env, form) {
  const feature = String(form.get('feature') ?? '');
  const plan = String(form.get('plan') ?? '');
  const model = String(form.get('model') ?? '').trim();
  if (!MODELS.some((m) => m.feature === feature && m.plan === plan)) return 'unknown model row';
  if (!MODEL_ID.test(model)) return 'not a model id';

  const applied = await push(env, `model:${feature}:${plan}`, model);
  await env.DB.prepare(`
    INSERT INTO models (feature_id, plan, model, applied, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (feature_id, plan) DO UPDATE SET
      model = excluded.model, applied = excluded.applied, updated_at = excluded.updated_at
  `).bind(feature, plan, model, applied ? 1 : 0, new Date().toISOString()).run();
  return null;
}

async function saveLimit(env, form) {
  const feature = String(form.get('feature') ?? '');
  const plan = String(form.get('plan') ?? '');
  const period = String(form.get('period') ?? '');
  const max = Number(form.get('max'));
  // An unchecked box sends nothing at all, which is the whole of "off".
  const enabled = form.get('enabled') !== null;

  const known = TIERS.some((t) => t.feature === feature && t.plan === plan);
  // At least one while it is on: zero is how a combination is turned off, and
  // the toggle owns that now, so a zero here would be two ways to say it.
  const valid = known && PERIODS.includes(period)
    && Number.isInteger(max) && max >= MIN_ALLOWANCE && max <= 1_000_000;
  if (!valid) return `an allowance has to be at least ${MIN_ALLOWANCE}`;

  // Off is pushed as zero, which is what ruchi-ai already reads as "none of
  // this for anyone". The real number stays in the row so it survives.
  const applied = await push(env, `limit:${feature}:${plan}`, `${enabled ? max : 0}:${period}`);
  await env.DB.prepare(`
    INSERT INTO limits (feature_id, plan, max_calls, period, enabled, applied, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (feature_id, plan) DO UPDATE SET
      max_calls = excluded.max_calls,
      period = excluded.period,
      enabled = excluded.enabled,
      applied = excluded.applied,
      updated_at = excluded.updated_at
  `).bind(feature, plan, max, period, enabled ? 1 : 0, applied ? 1 : 0, new Date().toISOString()).run();
  return null;
}

async function saveBurst(env, form) {
  const max = Number(form.get('max'));
  // Refused rather than quietly raised: a number the server would floor is a
  // number the page would then be showing wrongly.
  if (!Number.isInteger(max) || max < MIN_BURST || max > 1000) {
    return `imports in a row has to be between ${MIN_BURST} and 1000`;
  }

  const applied = await push(env, BURST.key, String(max));
  await env.DB.prepare(`
    INSERT INTO limits (feature_id, plan, max_calls, period, applied, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (feature_id, plan) DO UPDATE SET
      max_calls = excluded.max_calls,
      applied = excluded.applied,
      updated_at = excluded.updated_at
  `).bind(BURST.feature, BURST.plan, max, 'burst', applied ? 1 : 0, new Date().toISOString()).run();
  return null;
}

async function saveTrialClock(env, form) {
  const plan = String(form.get('trial') ?? '');
  const dial = TRIAL_CLOCK.find((d) => d.plan === plan);
  const max = Number(form.get('max'));
  // Zero is allowed here and nowhere else.
  if (!dial || !Number.isInteger(max) || max < 0 || max > dial.max_allowed) {
    return `that has to be a whole number of hours, 0 to ${dial ? dial.max_allowed : 8760}`;
  }

  const applied = await push(env, dial.key, String(max));
  await env.DB.prepare(`
    INSERT INTO limits (feature_id, plan, max_calls, period, applied, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (feature_id, plan) DO UPDATE SET
      max_calls = excluded.max_calls,
      applied = excluded.applied,
      updated_at = excluded.updated_at
  `).bind(dial.feature, dial.plan, max, 'hours', applied ? 1 : 0, new Date().toISOString()).run();
  return null;
}

/** Put every setting back to what ships. Deletes rather than writing defaults,
 * so ruchi-ai falls back to its own values and one number lives in one place. */
export async function resetSettings(env) {
  const live = [...TIERS.map((t) => `limit:${t.feature}:${t.plan}`),
    ...MODELS.map((m) => `model:${m.feature}:${m.plan}`),
    ...TRIAL_CLOCK.map((d) => d.key), BURST.key];
  const cleared = await send(env, [...new Set([...live, ...RETIRED.keys])].map((k) => ['DEL', k]));

  await env.DB.prepare('DELETE FROM limits').run();
  await env.DB.prepare('DELETE FROM models').run();
  return cleared ? null : 'the settings store could not be reached, so the servers may still hold the old values';
}

/** Everything the servers remember about who did what. trial:start is keyed to
 * the phone, so a spent trial follows a device around until this clears it. */
export const RECORD_PREFIXES = [
  'use:',
  'ai:req:', 'ai:spend:',
  'ratelimit:',
  'trial:start:',
];

export const RECORD_TABLES = [
  'usage_daily', 'errors_daily', 'ingredient_unresolved_daily', 'ingredient_correction_daily',
];

// A cursor that never returns to zero would otherwise spin forever.
const SCAN_ROUNDS = 200;
const REMOVE_BATCH = 200;

async function keysUnder(env, prefix) {
  const found = [];
  let cursor = '0';
  for (let round = 0; round < SCAN_ROUNDS; round += 1) {
    const body = await ask(env, [['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '1000']]);
    const page = body?.[0]?.result;
    if (!Array.isArray(page)) return null;
    const [next, keys] = page;
    if (Array.isArray(keys)) found.push(...keys);
    cursor = String(next);
    if (cursor === '0') return found;
  }
  return found;
}

/** Put the records back to nothing. Settings are left alone. */
export async function clearRecords(env) {
  let keys = [];
  for (const prefix of RECORD_PREFIXES) {
    const found = await keysUnder(env, prefix);
    if (found === null) return 'the counters could not be read, so nothing was cleared';
    keys.push(...found);
  }
  keys = [...new Set(keys)];

  for (let i = 0; i < keys.length; i += REMOVE_BATCH) {
    const batch = keys.slice(i, i + REMOVE_BATCH);
    if (!await send(env, batch.map((k) => ['DEL', k]))) {
      return 'the counters were only partly cleared, so run it again';
    }
  }

  for (const table of RECORD_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  return null;
}

/** Every setting shares this endpoint: validate, push to Upstash, record
 * whether it landed. Returns a failure string, or null when saved. */
export async function saveSetting(env, form) {
  if (form.get('records') !== null) return clearRecords(env);
  if (form.get('reset') !== null) return resetSettings(env);
  if (form.get('model') !== null) return saveModel(env, form);
  if (form.get('trial') !== null) return saveTrialClock(env, form);
  return form.get('burst') !== null ? saveBurst(env, form) : saveLimit(env, form);
}

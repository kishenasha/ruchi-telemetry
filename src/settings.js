/**
 * The two things this dashboard can change: which model each membership runs
 * on, and how many imports each membership gets. Both are enforced from
 * Upstash, which ruchi-ai reads on every request, so a change takes effect in
 * seconds without a redeploy. D1 holds the durable record of what was set and
 * whether the push actually landed.
 */

// Kept in step with lib/quota.py's DEFAULT_LIMITS by hand.
//
// Three memberships, one axis: a trial is a free cook spending their taste of
// Pro, so it runs Pro's model and saves without the editor. A recipe URL is
// the one source with two grades behind it (smart_import is the good model,
// quick_import the cheap one); pasted text and a photograph have one grade
// each and split on plan alone.
export const SOURCES = [
  { source: 'url', label: 'Recipe URL' },
  { source: 'text', label: 'Pasted text' },
  { source: 'image', label: 'Photo' },
];

export const TIERS = [
  { source: 'url', feature: 'smart_import', plan: 'trial', max: 5, period: 'life' },
  { source: 'url', feature: 'quick_import', plan: 'free', max: 10, period: 'month' },
  { source: 'url', feature: 'smart_import', plan: 'pro', max: 6000, period: 'month' },
  { source: 'text', feature: 'text_import', plan: 'trial', max: 5, period: 'life' },
  { source: 'text', feature: 'text_import', plan: 'free', max: 5, period: 'month' },
  { source: 'text', feature: 'text_import', plan: 'pro', max: 6000, period: 'month' },
  { source: 'image', feature: 'image_import', plan: 'trial', max: 3, period: 'life' },
  { source: 'image', feature: 'image_import', plan: 'free', max: 3, period: 'month' },
  { source: 'image', feature: 'image_import', plan: 'pro', max: 6000, period: 'month' },
];

// Kept in step with server/lib/models.py's DEFAULT_MODELS by hand. Two rows
// per source, not three: a trial reads Pro's row, which is what makes it a
// taste of Pro rather than a description of one.
export const MODELS = [
  { source: 'url', feature: 'quick_import', plan: 'free', model: 'google/gemini-2.5-flash-lite' },
  { source: 'url', feature: 'smart_import', plan: 'pro', model: 'openai/gpt-5.6-luna' },
  { source: 'text', feature: 'text_import', plan: 'free', model: 'google/gemini-2.5-flash-lite' },
  { source: 'text', feature: 'text_import', plan: 'pro', model: 'openai/gpt-5.6-luna' },
  { source: 'image', feature: 'image_import', plan: 'free', model: 'google/gemini-2.5-flash-lite' },
  { source: 'image', feature: 'image_import', plan: 'pro', model: 'openai/gpt-5.6-luna' },
];

// The one vocabulary for a membership, used everywhere a plan is shown.
export const PLAN_LABEL = { trial: 'Pro trial', free: 'Free', pro: 'Pro' };

export const PLAN_NOTE = {
  trial: 'A free cook spending their taste of Pro: the good model, saving without the editor',
  free: 'The cheap model, with the cook confirming before it saves',
  pro: 'What Pro buys, and a ceiling no real cook reaches',
};

// Which source a usage row belongs to, for a table grouped the way a cook
// experiences it rather than the way the server names it.
export const SOURCE_OF = {
  smart_import: 'url', quick_import: 'url', text_import: 'text', image_import: 'image',
};

export const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.source, s.label]));

/** The membership a usage row represents. Only a URL import needs the feature
 * to tell trial from free; everything else is the plan as recorded. */
export function planOf(featureId, plan) {
  if (plan === 'free' && featureId === 'smart_import') return 'trial';
  return plan;
}

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
  return tier ? planOf(tier.feature_id, tier.plan) : 'free';
}

/** Every membership a cook has been on, newest first, each named once. */
export function planHistory(cook) {
  const seen = [];
  for (const tier of cook?.tiers ?? []) {
    const plan = planOf(tier.feature_id, tier.plan);
    if (!seen.includes(plan)) seen.push(plan);
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

// ruchi-ai floors whatever it reads, since the brake fails closed and a zero
// would refuse every import for everyone. The form refuses it first, so the
// number shown is always the number enforced.
export const MIN_BURST = 3;

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
        applied: row.applied === 1,
        updatedAt: row.updated_at,
        custom: true,
      }
      : { ...tier, applied: true, updatedAt: null, custom: false };
  });
}

async function push(env, key, value) {
  if (!env.UPSTASH_URL || !env.UPSTASH_TOKEN) return false;
  try {
    const response = await fetch(`${env.UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([['SET', key, value]]),
    });
    return response.ok;
  } catch {
    return false;
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

  const known = TIERS.some((t) => t.feature === feature && t.plan === plan);
  const valid = known && PERIODS.includes(period)
    && Number.isInteger(max) && max >= 0 && max <= 1_000_000;
  if (!valid) return 'bad limit';

  // Pushed first: the stored row records whether enforcement actually has it,
  // so the page can never show a limit as live when it is not.
  const applied = await push(env, `limit:${feature}:${plan}`, `${max}:${period}`);
  await env.DB.prepare(`
    INSERT INTO limits (feature_id, plan, max_calls, period, applied, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (feature_id, plan) DO UPDATE SET
      max_calls = excluded.max_calls,
      period = excluded.period,
      applied = excluded.applied,
      updated_at = excluded.updated_at
  `).bind(feature, plan, max, period, applied ? 1 : 0, new Date().toISOString()).run();
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

/** Every setting shares this endpoint: validate, push to Upstash, record
 * whether it landed. Returns a failure string, or null when saved. */
export async function saveSetting(env, form) {
  if (form.get('model') !== null) return saveModel(env, form);
  return form.get('burst') !== null ? saveBurst(env, form) : saveLimit(env, form);
}

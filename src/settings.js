/**
 * The two things this dashboard can change: which model each membership runs
 * on, and how many imports each membership gets. Both are enforced from
 * Upstash, which ruchi-ai reads on every request, so a change takes effect in
 * seconds without a redeploy. D1 holds the durable record of what was set and
 * whether the push actually landed.
 */

// Kept in step with lib/quota.py's DEFAULT_LIMITS by hand. These are what the
// services fall back to, so the dashboard shows them as the live policy until
// something overrides them.
//
// quota.py also carries a quick_import/pro default, deliberately not listed
// here: a Pro cook is graded straight onto smart_import and never reaches it,
// so offering it as a setting would be a dial connected to nothing. The
// server keeps its default as a floor in case that routing ever changes.
export const TIERS = [
  { feature: 'smart_import', plan: 'free', grade: 'trial', max: 5, period: 'life' },
  { feature: 'quick_import', plan: 'free', grade: 'free', max: 10, period: 'month' },
  { feature: 'smart_import', plan: 'pro', grade: 'pro', max: 6000, period: 'month' },
  // Settable already so the numbers are agreed before the features land.
  { feature: 'text_import', plan: 'free', grade: 'free', max: 5, period: 'life', built: false },
  { feature: 'text_import', plan: 'pro', grade: 'pro', max: 6000, period: 'month', built: false },
  { feature: 'image_import', plan: 'free', grade: 'free', max: 3, period: 'life', built: false },
  { feature: 'image_import', plan: 'pro', grade: 'pro', max: 6000, period: 'month', built: false },
];

// Two ways to name the same four ids, because two pages ask different things
// of them. A usage breakdown cares which model ran, so it separates the two
// grades of URL import; the settings page cares what the cook was reaching
// for, and both grades of URL import are one button to them.
export const FEATURE_LABEL = {
  smart_import: 'Recipe URL, saves itself',
  quick_import: 'Recipe URL, cook confirms',
  text_import: 'Pasted text',
  image_import: 'Photo',
};

export const SOURCE_LABEL = {
  smart_import: 'Recipe URL',
  quick_import: 'Recipe URL',
  text_import: 'Pasted text',
  image_import: 'Photo',
};

export const GRADE_LABEL = { trial: 'Pro trial', free: 'Free', pro: 'Pro' };

export const GRADE_NOTE = {
  trial: 'A free cook on the good model, saving without the editor',
  free: 'A free cook on the cheap model, confirming before it saves',
  pro: 'What Pro buys, and a ceiling no real cook reaches',
};

// Kept in step with server/lib/models.py's DEFAULT_MODELS by hand.
export const MODELS = [
  { plan: 'free', model: 'google/gemini-2.5-flash-lite' },
  { plan: 'pro', model: 'openai/gpt-5.6-luna' },
];

// Same rule server side. A value that fails it is refused here rather than
// saved and silently ignored by the services.
export const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;

export const PERIODS = ['day', 'month', 'year', 'life'];

export const PERIOD_LABEL = {
  day: 'a day', month: 'a month', year: 'a year', life: 'for the life of the install',
};

export async function readModels(env) {
  const { results } = await env.DB.prepare('SELECT * FROM models').all();
  const saved = new Map((results ?? []).map((r) => [r.plan, r]));
  return MODELS.map((tier) => {
    const row = saved.get(tier.plan);
    return row
      ? { ...tier, model: row.model, applied: row.applied === 1, updatedAt: row.updated_at, custom: true }
      : { ...tier, applied: true, updatedAt: null, custom: false };
  });
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
  const plan = String(form.get('plan') ?? '');
  const model = String(form.get('model') ?? '').trim();
  if (!MODELS.some((m) => m.plan === plan)) return 'unknown plan';
  if (!MODEL_ID.test(model)) return 'not a model id';

  const applied = await push(env, `model:${plan}`, model);
  await env.DB.prepare(`
    INSERT INTO models (plan, model, applied, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (plan) DO UPDATE SET
      model = excluded.model, applied = excluded.applied, updated_at = excluded.updated_at
  `).bind(plan, model, applied ? 1 : 0, new Date().toISOString()).run();
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

/** Both settings share this endpoint: validate, push to Upstash, record whether
 * it landed. Returns a failure string, or null when saved. */
export async function saveSetting(env, form) {
  return form.get('model') !== null ? saveModel(env, form) : saveLimit(env, form);
}

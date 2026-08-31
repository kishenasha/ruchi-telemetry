/**
 * Every read of usage_daily. The table is a daily rollup, so a day is the
 * smallest thing anything here can ask about, and nothing needs to touch a
 * single call.
 */

const SORTS = {
  spend: 'micros DESC, calls DESC',
  imports: 'calls DESC, micros DESC',
  failed: 'errors DESC, calls DESC',
  recent: 'seen DESC',
};

export const SORT_LABEL = {
  spend: 'Spend', imports: 'Imports', failed: 'Failed', recent: 'Most recent',
};

const SUMS = `
  COALESCE(SUM(request_count), 0)    AS calls,
  COALESCE(SUM(cost_usd_micros), 0)  AS micros,
  COALESCE(SUM(cost_known_count), 0) AS priced,
  COALESCE(SUM(error_count), 0)      AS errors
`;

function dayAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

/** The inclusive day bounds of a window, `back` windows before the current one. */
export function bounds(days, back = 0) {
  if (days === null) return null;
  return { from: dayAgo(days * (back + 1) - 1), to: dayAgo(days * back) };
}

// Every caller builds its WHERE the same way, and days === null means all time.
function scoped(env, columns, tail, window, extra = [], extraBinds = []) {
  // The clauses and their values are built together, in one order. Kept apart
  // they drifted once, and a query silently answered nothing rather than
  // failing, which is the worst way for this to be wrong.
  const where = [...extra];
  const binds = [...extraBinds];
  if (window) {
    where.push('day >= ?', 'day <= ?');
    binds.push(window.from, window.to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return env.DB
    .prepare(`SELECT ${columns} FROM usage_daily ${clause} ${tail}`)
    .bind(...binds);
}

export async function totals(env, days, back = 0) {
  const columns = `${SUMS}, COUNT(DISTINCT user_hash) AS cooks`;
  const row = await scoped(env, columns, '', bounds(days, back)).first();
  return row ?? { calls: 0, micros: 0, priced: 0, errors: 0, cooks: 0 };
}

/** Spend and imports per day, oldest first, with empty days filled in so the
 * chart shows a gap as a gap rather than closing it up. */
export async function daily(env, days) {
  // The chart keeps its own span. A single bar for "today" says nothing, and
  // the shape of the fortnight behind it is the point of looking.
  const span = days === null ? 90 : Math.max(days, 14);
  const { results } = await scoped(
    env, `day, ${SUMS}`, 'GROUP BY day ORDER BY day', bounds(span),
  ).all();

  const found = new Map((results ?? []).map((r) => [r.day, r]));
  return Array.from({ length: span }, (_, i) => {
    const day = dayAgo(span - 1 - i);
    return found.get(day) ?? { day, calls: 0, micros: 0, priced: 0, errors: 0 };
  });
}

export async function breakdown(env, days, column) {
  // Only ever called with a column name from this file, never from a request.
  const { results } = await scoped(
    env,
    `${column} AS name, ${SUMS}, MAX(last_seen) AS seen`,
    `GROUP BY ${column} ORDER BY micros DESC, calls DESC LIMIT 100`,
    bounds(days),
  ).all();
  return results ?? [];
}

/**
 * One page of cooks. Grouped by person and tier together rather than by person
 * alone: a cook who upgraded mid-window has spend on both sides of the paywall,
 * and collapsing that would hide the one number the tiers exist to answer.
 */
export async function cooks(env, { days, sort = 'spend', plan = 'all', search = '', page = 0, perPage = 50 }) {
  const window = bounds(days);
  const extra = [];
  const binds = [];
  if (plan === 'free' || plan === 'pro') {
    extra.push('plan = ?');
    binds.push(plan);
  }
  if (search) {
    extra.push('user_hash LIKE ?');
    binds.push(`${search}%`);
  }

  const order = SORTS[sort] ?? SORTS.spend;
  const columns = `user_hash AS name, plan, ${SUMS}, MAX(last_seen) AS seen`;
  const tail = `GROUP BY user_hash, plan ORDER BY ${order} LIMIT ${perPage + 1} OFFSET ${page * perPage}`;
  const { results } = await scoped(env, columns, tail, window, extra, binds).all();

  const rows = results ?? [];
  // One row past the page is asked for rather than counted: knowing whether a
  // next page exists is all the pager needs, and a COUNT over every group is
  // the expensive part of this query.
  return { rows: rows.slice(0, perPage), more: rows.length > perPage };
}

/** One cook: their totals, their split by import type, and their day by day. */
export async function cook(env, hash, days) {
  const window = bounds(days);
  const [totalRow, features, days_] = await Promise.all([
    scoped(env, `${SUMS}, MIN(first_seen) AS started, MAX(last_seen) AS seen`,
      '', window, ['user_hash = ?'], [hash]).first(),
    scoped(env, `feature_id AS name, plan, ${SUMS}, MAX(last_seen) AS seen`,
      'GROUP BY feature_id, plan ORDER BY micros DESC', window, ['user_hash = ?'], [hash]).all(),
    scoped(env, `day, ${SUMS}`,
      'GROUP BY day ORDER BY day DESC LIMIT 60', window, ['user_hash = ?'], [hash]).all(),
  ]);
  return {
    totals: totalRow ?? { calls: 0, micros: 0, priced: 0, errors: 0 },
    features: features.results ?? [],
    days: days_.results ?? [],
  };
}

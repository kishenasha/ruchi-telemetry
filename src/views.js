/**
 * The four pages. Overview answers "is this fine", Cooks answers "who is
 * spending it", one cook answers "what did they do", Settings changes what the
 * next import costs. They are separate pages because they are separate
 * questions, asked at different times and at very different frequencies.
 */

import * as db from './queries.js';
import {
  chart, count, empty, esc, failures, money, nickname, panel, planTag,
  pricedNote, shell, stat, state, when, windowFrom, windowPicker,
} from './page.js';
import {
  FEATURE_LABEL, PERIODS, PERIOD_LABEL, readLimits, readModels,
} from './settings.js';

const PER_PAGE = 50;

function featureName(id) {
  return `<strong>${esc(FEATURE_LABEL[id] ?? id)}</strong>`;
}

function head(title, lede, right = '') {
  return `<div class="head">
    <div><h1>${esc(title)}</h1><p class="lede">${esc(lede)}</p></div>
    ${right}
  </div>`;
}

// -- overview ---------------------------------------------------------------

export async function overview(url, env) {
  const chosen = windowFrom(url);
  const [now, before, series, features, plans, top] = await Promise.all([
    db.totals(env, chosen.days),
    chosen.days === null ? null : db.totals(env, chosen.days, 1),
    db.daily(env, chosen.days),
    db.breakdown(env, chosen.days, 'feature_id'),
    db.breakdown(env, chosen.days, 'plan'),
    db.cooks(env, { days: chosen.days, perPage: 5 }),
  ]);

  const worked = (now.calls || 0) - (now.errors || 0);
  const perCall = now.calls ? money(Math.round((now.micros || 0) / now.calls)) : null;

  // The projection is the number that actually decides anything: a month total
  // in the past does not say whether the next one is affordable.
  const span = chosen.days;
  const projection = span && span > 1 && now.micros
    ? `<p class="lede">Running at ${money(Math.round(now.micros / span))} a day, which is about
       ${money(Math.round((now.micros / span) * 30))} a month at this rate.</p>`
    : '';

  const stats = [
    stat('Spend', money(now.micros), {
      sub: perCall ? `${perCall} an import` : 'nothing yet',
      now: now.micros, before: before?.micros, invert: true,
    }),
    stat('Imports', count(now.calls), {
      sub: `${count(worked)} worked`, now: now.calls, before: before?.calls,
    }),
    stat('Cooks', count(now.cooks), {
      sub: now.cooks ? `${money(Math.round((now.micros || 0) / now.cooks))} each` : 'none yet',
      now: now.cooks, before: before?.cooks,
    }),
    stat('Failed', count(now.errors), {
      sub: now.calls ? `${Math.round(((now.errors || 0) / now.calls) * 100)}% of imports` : 'none yet',
      now: now.errors, before: before?.errors, invert: true,
    }),
  ].join('');

  const body = `
${head('Overview', 'What imports are costing.', windowPicker(url, chosen))}
<div class="stats">${stats}</div>
${projection}

<h2>Day by day</h2>
${chart(series)}

<h2>Where it went</h2>
<div class="split">
  ${panel('By import type', '', `<table>
    <thead><tr><th>Type</th><th class="num">Imports</th><th class="num">Spend</th><th class="num">Failed</th></tr></thead>
    <tbody>${features.length
      ? features.map((r) => `<tr>
          <td>${featureName(r.name)}</td>
          <td class="num">${count(r.calls)}</td>
          <td class="num">${money(r.micros)}${pricedNote(r)}</td>
          <td class="num">${failures(r)}</td>
        </tr>`).join('')
      : empty('Nothing in this period.', 4)}</tbody>
  </table>`)}
  ${panel('By membership', '', `<table>
    <thead><tr><th>Membership</th><th class="num">Imports</th><th class="num">Spend</th><th class="num">Failed</th></tr></thead>
    <tbody>${plans.length
      ? plans.map((r) => `<tr>
          <td>${planTag(r.name)}</td>
          <td class="num">${count(r.calls)}</td>
          <td class="num">${money(r.micros)}${pricedNote(r)}</td>
          <td class="num">${failures(r)}</td>
        </tr>`).join('')
      : empty('Nothing in this period.', 4)}</tbody>
  </table>`)}
</div>

<h2>Spending the most</h2>
${panel('', '', `<table>
  <thead><tr><th>Cook</th><th>Plan</th><th class="num">Imports</th><th class="num">Spend</th><th class="when">Last one</th></tr></thead>
  <tbody>${top.rows.length
    ? top.rows.map((r) => `<tr>
        <td><a class="who" href="/cooks?id=${esc(r.name)}&amp;w=${esc(chosen.key)}">${esc(nickname(r.name))}</a></td>
        <td>${planTag(r.plan)}</td>
        <td class="num">${count(r.calls)}</td>
        <td class="num">${money(r.micros)}${pricedNote(r)}</td>
        <td class="when">${when(r.seen)}</td>
      </tr>`).join('')
    : empty('No cooks have imported yet.', 5)}</tbody>
</table>`)}
<p class="pager"><span></span><a href="/cooks?w=${esc(chosen.key)}">All cooks</a></p>
`;
  return shell('/', body);
}

// -- cooks ------------------------------------------------------------------

const SORTS = ['spend', 'imports', 'failed', 'recent'];

export async function cooks(url, env) {
  const chosen = windowFrom(url);
  const sort = SORTS.includes(url.searchParams.get('s')) ? url.searchParams.get('s') : 'spend';
  const plan = ['free', 'pro'].includes(url.searchParams.get('plan')) ? url.searchParams.get('plan') : 'all';
  // The search is a hash prefix, so anything that is not hex cannot match and
  // is dropped rather than sent to the database.
  const search = (url.searchParams.get('q') ?? '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 64);
  const page = Math.max(0, Math.min(400, Number(url.searchParams.get('p')) || 0));

  const { rows, more } = await db.cooks(env, { days: chosen.days, sort, plan, search, page, perPage: PER_PAGE });

  const link = (params) => {
    const next = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) next.searchParams.delete(k);
      else next.searchParams.set(k, v);
    }
    return esc(next.pathname + next.search);
  };

  const sorter = (key, label) => (
    `<a href="${link({ s: key, p: null })}" class="${sort === key ? 'on' : ''}">${esc(label)}</a>`
  );

  const filters = `
    <form class="filters" method="get">
      <input type="hidden" name="w" value="${esc(chosen.key)}">
      <input type="hidden" name="s" value="${esc(sort)}">
      <input type="search" name="q" value="${esc(search)}" placeholder="Start of a cook's code" spellcheck="false">
      <select name="plan">
        <option value="all"${plan === 'all' ? ' selected' : ''}>Every membership</option>
        <option value="free"${plan === 'free' ? ' selected' : ''}>Free only</option>
        <option value="pro"${plan === 'pro' ? ' selected' : ''}>Pro only</option>
      </select>
      <button type="submit">Find</button>
      ${search || plan !== 'all' ? `<a class="back" href="${link({ q: null, plan: null, p: null })}">Clear</a>` : ''}
    </form>`;

  const body = `
${head('Cooks', 'One row per person per membership. A cook who upgraded shows on both sides.', windowPicker(url, chosen))}
${filters}
${panel('', '', `<table>
  <thead><tr>
    <th>Cook</th><th>Plan</th>
    <th class="num">${sorter('imports', 'Imports')}</th>
    <th class="num">${sorter('spend', 'Spend')}</th>
    <th class="num">${sorter('failed', 'Failed')}</th>
    <th class="when">${sorter('recent', 'Last one')}</th>
  </tr></thead>
  <tbody>${rows.length
    ? rows.map((r) => `<tr>
        <td><a class="who" href="/cooks?id=${esc(r.name)}&amp;w=${esc(chosen.key)}">${esc(nickname(r.name))}</a></td>
        <td>${planTag(r.plan)}</td>
        <td class="num">${count(r.calls)}</td>
        <td class="num">${money(r.micros)}${pricedNote(r)}</td>
        <td class="num">${failures(r)}</td>
        <td class="when">${when(r.seen)}</td>
      </tr>`).join('')
    : empty(search ? 'No cook starts with that code.' : 'No cooks have imported yet.', 6)}</tbody>
</table>`)}
<div class="pager">
  <a class="${page === 0 ? 'off' : ''}" href="${link({ p: Math.max(0, page - 1) })}">Back</a>
  <span>${rows.length ? `${count(page * PER_PAGE + 1)} to ${count(page * PER_PAGE + rows.length)}` : ''}</span>
  <a class="${more ? '' : 'off'}" href="${link({ p: page + 1 })}">Next</a>
</div>
<p class="lede" style="margin-top:14px">
  Names are made up from a one way code. There is no way back to a person from here.
</p>
`;
  return shell('/cooks', body);
}

export async function oneCook(url, env, hash) {
  const chosen = windowFrom(url);
  const { totals, features, days } = await db.cook(env, hash, chosen.days);

  const perCall = totals.calls ? money(Math.round((totals.micros || 0) / totals.calls)) : null;
  const stats = [
    stat('Spend', money(totals.micros), { sub: perCall ? `${perCall} an import` : 'nothing yet' }),
    stat('Imports', count(totals.calls), { sub: `${count((totals.calls || 0) - (totals.errors || 0))} worked` }),
    stat('Failed', count(totals.errors), {
      sub: totals.calls ? `${Math.round(((totals.errors || 0) / totals.calls) * 100)}% of theirs` : 'none yet',
    }),
    stat('First seen', `<span style="font-size:16px">${when(totals.started) || '&mdash;'}</span>`, {
      sub: totals.seen ? `last ${when(totals.seen)}` : '',
    }),
  ].join('');

  const body = `
<p><a class="back" href="/cooks?w=${esc(chosen.key)}">&larr; All cooks</a></p>
${head(nickname(hash), 'One cook, by import type and by day.', windowPicker(url, chosen))}
<div class="stats">${stats}</div>

<h2>What they imported</h2>
${panel('', '', `<table>
  <thead><tr><th>Type</th><th>Plan</th><th class="num">Imports</th><th class="num">Spend</th><th class="num">Failed</th><th class="when">Last one</th></tr></thead>
  <tbody>${features.length
    ? features.map((r) => `<tr>
        <td>${featureName(r.name)}</td>
        <td>${planTag(r.plan)}</td>
        <td class="num">${count(r.calls)}</td>
        <td class="num">${money(r.micros)}${pricedNote(r)}</td>
        <td class="num">${failures(r)}</td>
        <td class="when">${when(r.seen)}</td>
      </tr>`).join('')
    : empty('Nothing in this period.', 6)}</tbody>
</table>`)}

<h2>Day by day</h2>
${panel('', '', `<table>
  <thead><tr><th>Day</th><th class="num">Imports</th><th class="num">Spend</th><th class="num">Failed</th></tr></thead>
  <tbody>${days.length
    ? days.map((r) => `<tr>
        <td>${esc(r.day)}</td>
        <td class="num">${count(r.calls)}</td>
        <td class="num">${money(r.micros)}${pricedNote(r)}</td>
        <td class="num">${failures(r)}</td>
      </tr>`).join('')
    : empty('Nothing in this period.', 4)}</tbody>
</table>`)}
`;
  return shell('/cooks', body);
}

// -- settings ---------------------------------------------------------------

export async function settings(env, failure = null) {
  const [limits, models] = await Promise.all([readLimits(env), readModels(env)]);

  const modelRows = models.map((m) => `
    <tr>
      <td>${planTag(m.plan)}</td>
      <td class="dim">${m.plan === 'pro'
    ? 'Reconstructs the recipe and saves it, no editor'
    : 'Tidies the recipe, then the cook confirms it'}</td>
      <td>
        <form method="post" class="set">
          <input type="hidden" name="plan" value="${esc(m.plan)}">
          <input type="text" name="model" value="${esc(m.model)}" class="wide"
                 pattern="[a-z0-9][a-z0-9._\\-]*/[a-z0-9][a-z0-9._:\\-]*" required>
          <button type="submit">Save</button>
        </form>
      </td>
      <td>${state(m)}</td>
    </tr>`).join('');

  const limitRows = limits.map((l) => `
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
    </tr>`).join('');

  const body = `
${head('Settings', 'Changes reach the servers within seconds. No app release, no redeploy.')}
${failure ? `<p class="warn">That change was refused: ${esc(failure)}.</p>` : ''}

${panel('Which model each membership uses', 'This is the whole difference between Free and Pro.', `<table>
  <thead><tr><th>Membership</th><th>What it does</th><th>Model</th><th>State</th></tr></thead>
  <tbody>${modelRows}</tbody>
</table>`)}

${panel('How many imports each membership gets', 'Per import type and membership, never per person. Zero turns that combination off.', `<table>
  <thead><tr><th>Import type</th><th>Membership</th><th>Allowance</th><th>State</th></tr></thead>
  <tbody>${limitRows}</tbody>
</table>`)}
`;
  return shell('/settings', body);
}

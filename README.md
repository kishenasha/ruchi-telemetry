# ruchi-telemetry

Permanent home for `ruchi-ai`'s AI usage records, and one private page that
reads them back. Phase 14 §14.8 in the Ruchi plan docs owns the architecture;
this repo is its implementation.

**Why it exists.** `ruchi-ai` already builds one metadata-only usage record per
AI call, but that record only ever reached a Cloud Run log line and an Upstash
counter that expires after 24 hours. Nothing could answer "how much has this
person spent this month", only "how much today". This keeps a permanent daily
rollup so quotas can eventually be set from measured cost instead of a guess.

```
ruchi-ai (Cloud Run)                    ruchi-telemetry (Cloudflare)
  accounting.py
    emit_usage_log()   -> Cloud Run logs
    forward_usage()    -----------------> POST /ingest -> D1 usage_daily
    record_usage()     -> Upstash (24h)                   GET / (dashboard)
```

The push is one way and best effort. `ruchi-telemetry` never calls `ruchi-ai`,
and a telemetry failure never becomes a failed or slowed AI call.

## What it stores

One row per day, per pseudonymous person, per feature, per plan: call count,
error count, spend in integer microdollars, how many of those calls had a known
cost, token counts, total latency, first and last seen.

A rollup rather than one row per call, on purpose. It answers week and month
totals, which the ephemeral counters structurally cannot, while staying small.

**It never receives or stores** recipe text or HTML, a prompt, a model response,
a receipt image, pantry contents, dietary preferences, or a raw RevenueCat
identifier. The ingest validator reads a fixed set of known fields and drops
everything else, so a field that should not be here cannot arrive by being
added upstream. `test/ingest.test.js` pins that.

**Unknown cost is not zero cost.** A call whose cost the provider never reported
adds nothing to a spend total and is counted separately, so the dashboard can
say "4 calls, 1 unpriced" rather than quietly implying the total is complete.

## Routes

| Route | Auth | What it is |
|---|---|---|
| `POST /ingest` | `Authorization: Bearer $INGEST_SECRET` | One usage record from `ruchi-ai` |
| `GET /` | HTTP Basic, any username, password is `$DASHBOARD_PASSWORD` | The dashboard |
| `GET /health` | none | Liveness only, returns `ok` |
| `GET /robots.txt` | none | `Disallow: /` |

Everything except `/health` and `/robots.txt` is `no-store` and
`X-Robots-Tag: noindex`. Preview URLs are disabled in `wrangler.jsonc`: one
address is easier to keep private than several.

Basic auth over HTTPS is what v1 uses because it needs no Zero Trust setup and
works in any browser. **Cloudflare Access is the better door** and can be put in
front of this Worker later without touching the code (Workers & Pages -> the
Worker -> Access -> protect behind Access). If that happens, `/ingest` needs a
service-token policy or its own hostname, since Access would otherwise
challenge `ruchi-ai`'s pushes too.

## Working on it

```sh
npm install
npm test                 # node --test, the ingest validator and secret compare
npx wrangler dev         # local, against a local D1
```

Deploy and migrate (this repo is deployed directly, not via GitHub):

```sh
npx wrangler deploy
npx wrangler d1 migrations apply ruchi-telemetry --remote
```

Secrets are set once with `npx wrangler secret put INGEST_SECRET` and
`npx wrangler secret put DASHBOARD_PASSWORD`, and are never in this repo.
`ruchi-ai` needs the matching `TELEMETRY_INGEST_URL` and
`TELEMETRY_INGEST_SECRET` in its own Cloud Run config.

Inspect the table directly when needed:

```sh
npx wrangler d1 execute ruchi-telemetry --remote --command "SELECT * FROM usage_daily"
```

## Not built

Per-person spend limits set from the dashboard, and `ruchi-ai` enforcing them.
Deliberately deferred: it turns a read-only page into a live dependency of the
AI path, which needs its own answer to what happens when this service is
briefly unreachable. See Phase 14 §14.8's "dashboard v2".

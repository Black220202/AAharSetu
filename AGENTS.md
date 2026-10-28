# AGENTS.md — AaharSetu

> **Keep this file current.** This is the memory a fresh opencode session starts
> from. Whenever you change the project's state (new feature, fixed bug, deploy,
> API change), update the matching section — especially **Current status**, the
> **Invariants** you touched, and the **Recent work log**. A stale AGENTS.md is a
> bug.

## What this is

AaharSetu — SPPU campus **surplus-food rescue** web app, two tiers:

1. **Tier 1 · human** — canteens/messes log edible surplus; NGOs/volunteers
   claim it inside a safe-consumption window using a one-time handshake code.
2. **Tier 2 · compost** — whatever isn't claimed (TTL expiry) plus raw scraps
   gets composted into bio-fertilizer.

Plus a live **impact ledger** (kg diverted, CO₂e avoided, bio-fertilizer yield).

**Zero dependencies.** Node built-ins only (`http`, `fs`, `crypto`, `os`) on the
server; vanilla ES5 browser JS (no modules, no build step, no framework) on the
client. `"engines": { "node": ">=18" }`.

## Run + verify

```bash
npm start          # boots server.js on PORT (default 3000); LAN URL printed at boot
npm run check      # syntax-check server+client + location-catalogue drift check
npm test           # 52 end-to-end API assertions on a scratch port/datafile
npm run check:ui   # drives the real UI in headless Edge via CDP, asserts no console errors
```

- `npm test` and `npm run check:ui` must pass before you call work done.
- Verify by hand: `node server.js`, open `http://localhost:3000`, hit
  **Sample data**, claim a card, watch the handshake flow.

## Deploy (Render)

Live target: **https://aaharsetu.onrender.com** (free plan, Singapore region),
built from GitHub `main` via the blueprint in `render.yaml`.

- Deploy path: push to `main` → Render auto-deploys → `node server.js`.
- **Free plan has no persistent disk.** `data.json` sits in the app directory and
  is wiped on every deploy/restart; the service also sleeps after 15 min idle
  (~30 s cold start). The board is a demo board, not a ledger of record.
- To make it durable: switch to `plan: starter`, uncomment the `disk:` block
  (mount `/var/data`) and the `DATA_FILE` env var in `render.yaml`.
- `ADMIN_TOKEN` is `sync: false`, so it is entered in the dashboard, never in
  git. If it is left empty, anyone with the URL can run `clear`/`demo`.
- `TRUST_PROXY=1` is set so rate limits bucket by `X-Forwarded-For`.
- Every file the page needs (`server.js`, `app.js`, `styles.css`, `index.html`,
  `favicon.svg`) **must be committed** — an untracked asset 404s in production.

## Invariants — do not regress these

These are the rules that earlier bugs violated. Treat each as law.

1. **Server crashes are not allowed to happen.** Any request-path throw must
   produce a 4xx/5xx response, never an uncaught exception. The handler wrapper
   and the `decodeURIComponent` try/catch in `server.js` exist for this; keep
   new code inside them and keep `npm test`'s malformed-path block green.
2. **The handshake code is a shared secret.** It must NEVER be rendered on the
   shared board, never pre-filled into the verify prompt, never logged. It goes
   out exactly once (the claim toast). Card copy reads "Code issued to …".
   `npm run check:ui` asserts no `#[A-Z]{3}-###` string appears in the grids.
3. **`complete` and `handshake` are channel-guarded.** `complete` only on
   `channel === "compost"`; `handshake` only on `channel === "human"`. A human
   batch must never be closed as composted, or its meals vanish from `impact()`.
4. **Board-wide ops (`clear`, `demo`) require `ADMIN_TOKEN` when configured.**
   Never extend the token gate to single-batch ops (`post`, `claim`, `release`,
   `complete`, `handshake`) — a token-protected instance still has to be usable
   by claimants. Compare secrets with `secretEquals` (timing-safe), not `===`.
5. **Keep-alive clients must not be poisoned.** On early request abort (the 413
   path) send `Connection: close` and destroy only after the response flushes.
   Any other mid-request teardown must do the same.
6. **`persist()` failures are logged, never silent.** Writes go through the
   serialized `writes` queue with atomic tmp+rename; keep it that way so two
   devices can't interleave.
7. **Locations are server-canonical.** `LOCATIONS` in `server.js` is the single
   source of truth; `FALLBACK_LOCATIONS` in `app.js` (offline only) must stay
   byte-equivalent. `npm run check` enforces this — fix the scripts, not by
   removing the check.
8. **Writes are single-op mutations**, never whole-state overwrites, so two
   devices claiming one batch can't clobber each other.
9. **Static serving is an allowlist** (`STATIC_ASSETS` = index.html, app.js,
   styles.css, favicon.svg). Never serve arbitrary files under `ROOT`: on a
   public host `GET /data.json` would hand out every live handshake code and
   expose `server.js`/`AGENTS.md`. `npm test` asserts those paths 404 — add a new
   asset to the set instead of loosening the check.

## Architecture map

| File | Role |
|---|---|
| `server.js` | Single authoritative server. Validation (`sanitizeBatch`), TTL sweep, serialized op queue, atomic persist, rate limiting, CSP security headers, allowlisted static serving. |
| `app.js` | Single-page client. Ops mirror the server; falls back to `localStorage` + `localOp` when the server is unreachable. ES5, no externals. |
| `index.html` | One page, 4 tab-panels (donor / live feed / compost / impact). No inline scripts — CSP forbids them. |
| `styles.css` | All styling. Dark theme, Inter/Space Grotesk/JetBrains Mono via Google Fonts (whitelisted in CSP). |
| `data.json` | Board persistence file. **Gitignored**; may be absent or `[]` on boot. |
| `package.json` | `start` / `check` / `test` / `check:ui` scripts. |
| `render.yaml` | Render (free web service) manifest. Env: `ADMIN_TOKEN` (`sync:false`), `TRUST_PROXY=1`, optional `DATA_FILE`+disk for durable storage. |
| `scripts/test.js` | 52-assertion API test (spawns servers on scratch ports, tests admin-token and keep-alive behaviour). |
| `scripts/check-locations.js` | Drift check between the two location catalogues. |
| `scripts/browser-check.js` | Headless-Edge CDP driver; boots the real page and asserts the UI flow + no console errors. |

## Client ← → server contract

- `GET /api/state` → `{ posts, locations, now }`. `/api/op, POST` takes one op
  `{ type, ... }` → `{ ok, posts }` (or `{ ok:false, error, conflict? }`).
- Ops: `post`, `claim`, `release`, `handshake`, `complete`, `cancel`, `clear*`,
  `demo*`  (* = token-gated). Conflict → 409, rate limit → 429, bad JSON →
  400, oversized body → 413.
- Batch fields are sanitized server-side; the client's batch shape (id,
  channel, status, item, qty, kg, prepAt, windowMin, safeUntil, locId, code,
  claimedAt/By, handshakeAt, reroutedAt, compostedAt, compostUnit, yieldKg,
  created) is the contract. Keep both sides in sync.
- Impact constants live in `app.js` only: `MEAL_KG=1`, `CO2_PER_MEAL=2.5`,
  `CH4_PER_KG=0.5`, `GWP=28`, `COMPOST_YIELD=0.35`.

## Env vars (server)

`PORT` (3000), `DATA_FILE` (./data.json), `ADMIN_TOKEN` (board-gates clear/demo
when set), `TRUST_PROXY=1` (bucket rate limits by X-Forwarded-For behind
Render's proxy).

## Working agreements

- **No new dependencies.** If you think you need one, export it to `scripts/`
  like the existing node-only helpers.
- Client code stays **ES5 + no inline JS** (CSP), server stays dependency-free.
- Run `npm run check` + `npm test` (+ `npm run check:ui` when the client
  changed) before finishing.
- On a harness failure, that's a real signal — fix the code, not by disabling
  the check.
- Don't commit unless asked.

## Current status

- All six reported bugs fixed and verified (see log): remote crash,
  handshake-theater, channel-guarded terminal ops, silent persist failures,
  413 keep-alive poisoning, admin-token gate. Plus: hidden-toast click
  swallow, missing favicon, proxy rate-limit bucketing, dead `id()`.
- `scripts/test.js` = **52 pass / 0 fail**; `npm run check` green;
  `npm run check:ui` green (real UI in headless Edge, zero console errors).
- Data file is empty (`[]`) — a live board.
- `render.yaml` is free-plan safe (no disk, `region: singapore`); deployment
  notes live under **Deploy (Render)** above.

## Next steps / open items

- Create the Render Blueprint from `render.yaml` and enter `ADMIN_TOKEN`; then
  smoke-test the live URL (board loads, claim + handshake works, assets 200).
- Optional: move to `plan: starter` + disk if the board must survive deploys.

## Recent work log

- (2026-10-29) Public-hosting hardening: the static handler served any file under
  `ROOT`, so a deployed instance leaked `data.json` (live handshake codes) and
  its own source. Replaced with a `STATIC_ASSETS` allowlist; added 9 assertions
  (52 total) for private paths + real assets; `npm run check:ui` still green.
- (2026-10-29) Render deployment prep: rewrote `render.yaml` for the free plan
  (removed the disk, which Render only allows on paid services — the old
  blueprint would fail), added `region: singapore`, kept `ADMIN_TOKEN`
  (`sync:false`) + `TRUST_PROXY=1`, documented the paid-tier disk upgrade path;
  added the **Deploy (Render)** section. Committed the previously untracked
  `app.js`, `styles.css`, `favicon.svg`, `scripts/`, `AGENTS.md` — without them
  a Git-based deploy 404s on its own assets.

- (2026-09-28) "remove all bugs" session: fixed and regression-tested the six
  bugs above; added `scripts/test.js`, `scripts/browser-check.js`,
  `scripts/check-locations.js`, `favicon.svg`; wired `check`/`test`/`check:ui`
  into `package.json`; documented `ADMIN_TOKEN`/`TRUST_PROXY` in `render.yaml`.
  Nothing committed.
# CLAUDE.md

9Router (`9router-app`): local AI routing gateway + Next.js dashboard. One OpenAI-compatible
endpoint (`/v1/*`) routes to 40+ providers with format translation, combo/account fallback,
OAuth/API-key creds, token refresh, usage tracking. Code: `src/` (Next app + APIs), `open-sse/`
(provider-agnostic engine), `cli/` (npm `9router` launcher — own package.json/version/build), `tests/`.

## Commands
- Dev: `npm run dev` → **port 20127** (script hardcodes `--port 20127`; `PORT` env ignored).
  `dev:webpack` for webpack.
- Prod: `npm run build && npm run start` → also 20127. Port **20128** is the `9router` CLI
  default and `.env.example`. Dashboard `/dashboard`, API `/v1`.
- Lint: `npx eslint .`

## Tests (`tests/` is an independent ESM package, not wired to root `npm test`)
Root `npm install` first, then `cd tests && npm install && npx vitest run [unit/x.test.js]`.
Ignore `tests/package.json`'s `test` script (hardcoded `/tmp` NODE_PATH).
Suite is **not** green on a clean checkout (~130 fails, many network/load flakes) — judge
regressions by diffing failing sets against a pristine `master` run, never a raw count. Ignore
upstream's `verify-no-regression.mjs`/`known-fails.txt` (stale, assumes `/app/` paths). Expected red:
- `unit/embeddings.cloud.test.js` (imports `cloud/`, not in this repo);
- `unit/xai-oauth-service.test.js` (5s timeout without xAI network);
- `tests/translator/real/*.real.test.js` (live calls; need credentials).

After touching provider registry / aliases, run `tests/__baseline__/verify-*.mjs`.

## Architecture
Read before re-deriving: `docs/ARCHITECTURE.md` (system, fallback, OAuth, sync — persistence
section is stale, see below) and `open-sse/AGENTS.md` (**required before editing `open-sse/`**).

Request flow: `src/app/api/v1/*` (rewrite `/v1/*`→`/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (combo expansion, account loop)
→ `open-sse/handlers/chatCore.js` (format detect, translate, token savers, dispatch, retry)
→ `open-sse/executors/*` (`default.js` = any OpenAI-compatible) ↔ `open-sse/translator/*` → SSE.
`src/sse/` is app glue; `open-sse/` is standalone-capable — cross that boundary consciously.

### Translator
- Pivots through OpenAI. A translator registered on an exact `source:target` pair is a direct
  route (skips lossy double-hop) — prefer it for thinking blocks, tool ids, non-base64 images, `is_error`.
- Translators self-register via `register(from, to, reqFn, resFn)` on import — a new file MUST be
  imported in `open-sse/translator/index.js` or it never runs.
- No hardcoded role/block/model strings: use `open-sse/translator/schema/` and `open-sse/config/`.
- Binary upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) live in their executor.

### Provider registry
`open-sse/providers/registry/index.js` is auto-generated — regenerate with
`scripts/migrate-registry.mjs` / `scripts/injectDisplayToRegistry.mjs`, never hand-edit.
New provider: copy `open-sse/providers/REGISTRY_TEMPLATE.js`, add models to
`open-sse/config/providerModels.js`; executor only for non-OpenAI-compatible upstreams.

### Persistence (ARCHITECTURE.md still says `db.json` — wrong)
SQLite under `src/lib/db/`; `driver.js` fallback: `bun:sqlite` → `better-sqlite3` (keep it in
`optionalDependencies`) → `node:sqlite` (Node ≥22.5) → `sql.js`. Import `@/lib/db/index.js`
(`src/lib/localDb.js` is a compat shim); entity logic in `repos/*`, schema in `migrations/`.
DB path: `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`). Usage/logs (`src/lib/usageDb.js`)
stay under `~/.9router` and ignore `DATA_DIR`.

### Token savers (`open-sse/rtk/`, run in `chatCore.js` after translation)
RTK compresses `tool_result` in place; skips `is_error`/`status:"error"`. Also here: headroom
(external compression proxy) and caveman/ponytail (append style prompts to the system message
when enabled in dashboard settings). All **fail-open** — return null, never throw.
Client opt-out: header `x-9router-token-saver: off` (disables all of them).

## Conventions
- Plain ESM JavaScript, no TypeScript; `@/*` → `src/*`.
- `custom-server.js` derives client IP from the TCP socket and strips attacker-controlled
  `X-Forwarded-For` (trusted only from a loopback proxy). Preserve when touching IP/rate-limit code.
- `INITIAL_PASSWORD` defaults to `123456` — must override. Env contract: `.env.example`.
- **Security-first on PRs**: when reviewing or creating PRs, audit auth, credential/token storage
  and leaks, header manipulation (`X-Forwarded-For`), and SSRF before functional logic; always
  include explicit security notes in the report.
- Root and `cli/` version independently; log in `CHANGELOG.md`; Conventional Commits.

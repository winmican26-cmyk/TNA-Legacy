# TNA Deployment Bootstrap & Readiness v0.1 — Verification Plan

Verification is split into **(A) orchestration-layer unit verification** (environment-independent, run via
`npm run check`) and **(B) live pilot verification** (requires Docker + a running stack). Fixtures are
inputs only — never authoritative outcomes. Authoritative results come from the components that observed
them.

## A. Orchestration-layer unit verification — `tests/deployment/bootstrap-orchestration.test.ts`
Status at this writing: **PASS** (part of the green `npm run check`: 1173 pass / 0 fail / 0 skip, exit 0).

| Property | Test |
|---|---|
| Preflight is read-only and emits the four verdicts | "preflight is read-only … four verdicts" |
| Missing Docker is a blocking FAIL (not safe to proceed) | "missing Docker is a blocking FAIL" |
| A blocking UNKNOWN is never promoted to PASS | "a blocking UNKNOWN is never promoted to PASS" |
| A port already in use is a blocking FAIL | "a port already in use is a blocking FAIL" |
| A fully healthy real pilot can reach GO | "a fully healthy real pilot can reach GO" |
| A failed governed action can never be PASS/GO | "a failed governed action can NEVER read as PASS/GO" |
| A NOT_RUN governed action is INSUFFICIENT_EVIDENCE | "a NOT_RUN governed action is INSUFFICIENT_EVIDENCE" |
| Zero restart cycles cannot be GO | "zero restart cycles cannot be GO" |
| Localhost rehearsal capped at GO_WITH_LIMITATIONS | "a localhost rehearsal is capped at GO_WITH_LIMITATIONS" |
| KNOWN_BYPASS never a clean GO | "a KNOWN_BYPASS … can never be a clean GO" |
| NOT_RUN exposure/backup caps below GO | "NOT_RUN public exposure or backup caps below GO" |
| Evidence package self-verifies; tamper detected | "builds, self-verifies, and detecting tamper fails verification" |
| Evidence build refuses secret-shaped content | "refuses to build if secret-shaped content is present" |
| Secret scan detects keys/values at any depth | "detects secret-shaped keys at any depth and passes clean data" |

Also verified in the same green `npm run check`:
- Typecheck of the new `packages/deployment-bootstrap` under strict TS (passes).
- Lint clean (only the pre-existing `vad-runtime:166` cosmetic warning).
- **The real Docker container build test now RUNS and PASSES** (previously skipped) — confirming the
  production image builds from current source after the claude-hook manifest correction.

## B. Live pilot verification (requires Docker + running stack) — NOT YET RUN
To be executed against the real pilot stack and reported with ACTUAL values (never fabricated):

1. `npm run tna:deploy -- preflight` → PASS/WARN (no blocking FAIL/UNKNOWN).
2. `prepare` (`tna init`) → data dir + component DBs + deployment identity.
3. `start` (compose.pilot up) → all mandatory services healthy; only Caddy publishes 80/443.
4. `bootstrap` → first admin created; platform pilot agent registered (restart-safe); real tenant minted
   + activated; registry built from the real id.
5. `verify` → ONE real governed action through the accepted Platform; capture request_id, Gate decision,
   capability_id, Sentinel session id, result_hash, final_state (from the real action record). Run
   `pilot-verify.js` for exposure/CORS/CSRF/headers and the documented Ledger/Auditor 503s.
6. **Restart persistence** — ≥3 stop/restart cycles proving tenant, admin account, Gate agent identity,
   envelope, and governed action all survive, with no duplicate-identity conflict and no fabricated state.
7. **Failure-state honesty** — Platform/CG/Sentinel unavailable, invalid tenant/credential, missing secret,
   malformed registry, known-bypass — each must surface as unhealthy, never green.
8. `readiness` → aggregate real outputs via `assessGoLive`; write the non-secret evidence package to
   `data/deployment-evidence/<deployment-id>/`.

Because this is a `localhost`/Docker-Desktop host, the live run is a LOCAL REHEARSAL; the honest ceiling
is GO_WITH_LIMITATIONS. Any phase not actually executed is reported NOT_RUN, never PASS.

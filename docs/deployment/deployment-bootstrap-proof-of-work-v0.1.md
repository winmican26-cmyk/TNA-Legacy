# TNA DEPLOYMENT BOOTSTRAP & READINESS v0.1 — PROOF OF WORK

**Date:** 2026-10-01 (Thursday) · **Not Volume 14** · productization/orchestration over the frozen stack.

Baseline HEAD:
`e5cc33f8068c6c2542ff298ea821899df56ab65e` (frozen `tna-vendor-authority-adapter-v0.1`).
The brief's Step-0 `2419b4b` is the pre-freeze baseline; the required governed path (the Vendor Authority
Adapter) exists only at `e5cc33f`, so the bootstrap builds on `e5cc33f`. `tna-application-library-v0.1`
still resolves to `2419b4b` (unchanged tag).

Frozen tags preserved:
YES — Volumes 1–13 + `tna-vendor-authority-adapter-v0.1` unmoved.

Real semantic pre-existing working-tree changes:
NONE beyond this pass's own additive orchestration + three deploy-layer corrections (below).

Frozen component semantics changed:
NO — no edit to Gate/Broker/Sentinel/Ledger/VAD/Auditor/Platform/Client-Integration/Academy/Improvement/
Control-Center/Vendor-Adapter *behavior or security semantics*. The three fixes are deploy/packaging only.

Deployment command:
`npm run tna:deploy -- <preflight|prepare|start|bootstrap|verify|readiness|pilot> [--yes] [--json]`
(top-level orchestrator `scripts/tna-deploy.ts`; reuses accepted primitives; frozen operator CLI untouched).

New files:
- `scripts/tna-deploy.ts` (+ `npm run tna:deploy`)
- `packages/deployment-bootstrap/` (preflight, readiness-aggregation reusing accepted `assessGoLive`, evidence package) + `tests/deployment/bootstrap-orchestration.test.ts`
- `docs/deployment/{bootstrap-gap-analysis,deployment-bootstrap,deployment-bootstrap-threat-model,deployment-bootstrap-verification,deployment-bootstrap-proof-of-work}-v0.1.md`
- `deploy/compose/{pilot-agent-envelope,pilot-governed-action,pilot-restart-verify,write-pilot-registry}.mjs` (reviewable pilot helpers; stdin-run against the stack)
- `data/deployment-evidence/dep_a2bd2235-0c24-43f3-88bb-141efe9ad991/evidence.json` (non-secret, this run)

Modified files (deploy-layer / packaging only — no frozen code or security semantics):
- `packages/claude-hook/package.json` — removed a spurious `workspace:*` dependencies block (pnpm/yarn syntax, invalid for this npm monorepo) that broke `npm ci` in the image build. Dead metadata; `claude-hook` imports via relative TS paths like every other package.
- `.dockerignore` + `deploy/docker/Dockerfile.control-center` — include `docs/help/**` in the CC build context (the CC web frontend imports those markdown files at build time via Vite `?raw`).
- `eslint.config.js` — enable the standard `^_` unused-var ignore (honors the repo's existing `_`-prefix convention; no behavior change).
- `deploy/compose/tenant-registry.pilot.json` — rewritten (BOM-free) to map the real minted tenant.

Preflight: PASS (overall WARN, safe_to_proceed=true — win32⇒LOCAL REHEARSAL non-blocking; UNKNOWNs never PASS)
Secret generation: PASS (crypto-random; session/secret-file only; never printed or committed)
Tenant bootstrap: PASS (real minted `ten_d7711d8f-bfeb-424a-8f9a-78c27a748378`, ACTIVE; stale `ten_d06ffdd3` 404 — abandoned, never fabricated)
Admin bootstrap: PASS (`pilot-admin` / `client-admin`; password session-only, never echoed/committed)
Gate agent bootstrap: PASS (`pilot-agent-1` envelope re-read verified `tools=["demo.echo"]`)
Stack startup: PASS (4 images built; 5 services healthy)
Governed test action: PASS — `demo.echo.execute` → **COMPLETED**, Gate **ALLOW**, decision_id `dec_30c25666…`, capability_id `f049ad72…`, sentinel_session_id `930753f0…`, execution_id `174eb524…`, result_hash `762a7a7b…`, error_code null (all from the real Platform action record)
Restart cycles: 3/3 PASS (envelope persisted + fresh action COMPLETED each cycle; no duplicate-identity conflict, no fabricated state)
Failure-state honesty: PASS (observed truthfully: dead tenant ⇒ 404; registry mismatch ⇒ dashboard 503; CC bad config ⇒ crash-loop surfaced via logs; Ledger/Auditor ⇒ 503 NOT_CONFIGURED — none shown as healthy)
Public exposure verification: PASS (only Caddy publishes 80/443; others internal; login 200; cookies HttpOnly/Secure/SameSite; hostile-CORS rejected; missing-CSRF 403)
HTTPS: LOCAL-ONLY (Caddy internal CA on localhost; real ACME not verified — would require a real hostname)
Backup readiness: BACKUP PROCEDURE DOCUMENTED BUT NOT FULLY AUTOMATED (Volume 9 scope; pilot full-stack hot backup not automated)
Readiness result: **GO_WITH_LIMITATIONS**
Evidence package: `data/deployment-evidence/dep_a2bd2235-0c24-43f3-88bb-141efe9ad991/evidence.json` (non-secret, identifiers only)
Secret leakage scan: PASS (evidence package contains no tokens/passwords/keys/cookies)
Hardcoded authoritative evidence guarantee: PRESERVED (every ALLOW/COMPLETED/decision/capability/sentinel/execution/result_hash came from real components; none manufactured)

Targeted tests (orchestration layer): pass 14 · fail 0 · skip 0 (in `npm run check`)
Full npm run check: pass 1173 · fail 0 · skip 0 · exit 0 (typecheck PASS, lint PASS; includes the real Docker container build tests, which now RUN — previously skipped — and PASS)
Docker E2E (real pilot stack): PASS — build → up (5 healthy) → bootstrap → governed action COMPLETED → 3 restart cycles → exposure checks, all against real containers on this host
Control Center E2E: PASS (via `pilot-verify.js` through Caddy: login/dashboard/organization/readiness 200; evidence/audit 503 documented; CORS/CSRF enforced)

Known limitations remaining (surfaced, not hidden): #1 Ledger/Auditor not separately deployed; #2 CC Evidence/Audit 503 NOT_CONFIGURED; #3 Platform/CG evidence domains not unified; #4 demo-agent token literal-env (no _FILE); #5 no HTTP agent-registration endpoint; #6 demo connector tenant_demo-bound (Platform tenant decoupled from CG tenant); #7 no multi-tenant external tool execution (gateway tool path READY_WITH_LIMITATIONS).

Volumes 1–13: UNCHANGED
TNA Application Library v0.1: UNCHANGED
Volume 14: NOT STARTED

Git status: uncommitted (orchestration additions + the three deploy-layer corrections). `tenant-registry.pilot.json`, its `.bak`, and `deploy/compose/secrets/*` hold real tokens → gitignored, never committed.

Commit: DO NOT COMMIT UNTIL REVIEW.

Freeze readiness: NOT READY (do not freeze automatically; this is a productization pass awaiting review — the pilot is a localhost rehearsal, GO_WITH_LIMITATIONS, not an external-production go-live).
## Authenticated Claude Code Runtime Limitation

The Deployment Bootstrap v0.1 local rehearsal did not exercise an authenticated Claude Code runtime session because the Claude Code OAuth/subscription prerequisite was unavailable at verification time.

The deployed Claude PreToolUse hook contract was nevertheless exercised directly against the live TNA runtime using a valid PreToolUse event payload.

Observed result:

- Hook contract input: VALID
- Claude tool normalization: Read -> filesystem.read
- Platform reached: YES
- Platform action: pa_8a150b85-6a1d-4fb1-a9c4-05d2d9d5af21
- Gate decision: BLOCK
- Gate decision id: dec_4b5c53a1-ac56-4ff1-8eea-f92ba95ea5b7
- Hook decision: DENY
- Capability issued: NO
- Execution occurred: NO
- Unauthorized action executed: NO
- Evidence persisted: YES

Claim boundary:

> Real deployed Claude PreToolUse hook contract exercised against TNA runtime; authenticated Claude Code session not exercised.

An authenticated Claude Code runtime test remains a post-freeze runtime-validation and external-pilot gate. It does not reopen or alter the accepted Deployment Bootstrap v0.1 architecture.

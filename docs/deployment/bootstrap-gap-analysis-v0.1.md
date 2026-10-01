# TNA Deployment Bootstrap & Readiness v0.1 — Gap Analysis

**Baseline HEAD:** `e5cc33f8068c6c2542ff298ea821899df56ab65e` (frozen `tna-vendor-authority-adapter-v0.1`).
**Note on the brief's stated baseline:** the brief's Step 0 names `2419b4b…` and `tna-application-library-v0.1`.
That hash is the *pre-freeze* baseline; this session accepted-and-froze the Vendor Authority Adapter at
`e5cc33f`, and the brief's own opening line requires exercising the *frozen adapter integration* — which
only exists at `e5cc33f`. We therefore build on `e5cc33f`. `tna-application-library-v0.1` still resolves to
`2419b4b` (unchanged); it is simply an older tag, not the current HEAD.

This is a **productization / orchestration** layer. It reuses existing accepted primitives and MUST NOT
change any frozen component semantics.

---

## Deployment primitives — classification

| Primitive | Path | Status | Reuse in bootstrap |
|---|---|---|---|
| `tna init` | `scripts/tna-init.ts` | **EXISTS** | Called by `deploy prepare` to create data dir + component DBs + deployment identity. **MUST NOT CHANGE.** |
| `tna verify` | `scripts/tna-verify.ts` | **EXISTS** | Aggregated into `deploy readiness`. **MUST NOT CHANGE.** |
| `tna backup` / `tna restore` | `scripts/tna-backup.ts`, `scripts/tna-restore.ts` | **EXISTS** | Surfaced in backup-readiness reporting (Volume 9 scope). **MUST NOT CHANGE.** |
| Pilot platform-agent bootstrap | `scripts/pilot-bootstrap-platform-agent.ts`, `deploy/compose/bootstrap-platform-agent.js` | **EXISTS** (restart-safe, identity-conflict fails closed) | Called by `deploy bootstrap`. **MUST NOT CHANGE** (duplicate tolerance + fail-closed identity are accepted semantics). |
| Control Center user creation | `scripts/control-center-create-user.ts` | **EXISTS** | Called by `deploy bootstrap` admin step. **MUST NOT CHANGE.** |
| Operator `doctor` | `apps/tna-operator/src/doctor.ts` | **EXISTS** | Aggregated into `deploy readiness`. **MUST NOT CHANGE.** |
| Operator `go-live assess` | `apps/tna-operator/src/go-live.ts` (`assessGoLive`) | **EXISTS** | **Authoritative readiness decision engine.** Reused verbatim — GO/GO_WITH_LIMITATIONS/NO_GO/INSUFFICIENT_EVIDENCE, KNOWN_BYPASS-never-clean-GO, blocking-vs-nonblocking. **MUST NOT CHANGE.** |
| Operator `handoff` | `apps/tna-operator/src/handoff.ts` | **EXISTS** | Optional attachment to evidence package. **MUST NOT CHANGE.** |
| Pilot compose topology | `deploy/compose/compose.pilot.yaml` | **EXISTS** | Orchestrated by `deploy start`. **MUST NOT CHANGE** (only Caddy publishes 80/443; internal services private). |
| Pilot stack verifier | `deploy/compose/pilot-verify.js` | **EXISTS** | Wrapped by `deploy verify` (login, dashboard, org, readiness, documented 503s, hostile-CORS, missing-CSRF). **MUST NOT CHANGE.** |
| Tenant registry (pilot) | `deploy/compose/tenant-registry.pilot{,.example}.json` | **EXISTS** | Built from the *real minted* tenant id; never fabricated. |
| Runbook / verification / checklists | `docs/deployment/pilot-deployment-runbook-v0.1.md`, `…-verification-v0.1.md`, `docs/operator/client-{deployment-checklist,go-live}-v0.1.md`, `docs/client-integration/onboarding-readiness-v0.1.md` | **EXISTS** | The manual steps the orchestrator productizes. Updated only where the orchestrator replaces a manual step; frozen historical proofs untouched. |

---

## What the bootstrap layer must ADD (orchestration only)

| Capability | Status today | Bootstrap adds |
|---|---|---|
| Single guided multi-phase command (`preflight/prepare/start/bootstrap/verify/readiness`, plus `pilot` umbrella) | **PARTIALLY EXISTS** — the phases exist as separate scripts/commands, but there is no single resumable operator workflow | A thin orchestrator that sequences the existing primitives, each phase separately runnable and resumable; shows what it will do before consequential actions. |
| **Read-only preflight** (OS, Node, Docker, Compose v2, fs access, config files, hostname, DNS, ports 80/443, expected revision, committed-secret scan, disk, memory, existing-deployment/volume/registry/env detection, time sync) | **MISSING** as a single gate (pieces live in `doctor`) | New `preflight` module emitting PASS/WARN/FAIL/UNKNOWN — UNKNOWN never treated as PASS; never mutates infra. |
| **Secure secret generation** for the pilot set | **PARTIALLY EXISTS** — runbook documents it manually | Productized generator: crypto-random, restrictive perms, never printed/committed; gitignored env. |
| **Tenant bootstrap from real mint** | **PARTIALLY EXISTS** — manual Client Gateway call in runbook | Orchestrated: start CG → wait real readiness → real create → capture minted id → activate → persist to gitignored config → build registry. Never fabricates an id. |
| **Readiness aggregation** into one operator verdict | **PARTIALLY EXISTS** — `go-live` + `doctor` + `tna verify` + onboarding readiness exist separately | Aggregator that assembles their **real** outputs into `assessGoLive()` — no competing readiness model. |
| **Deployment evidence package** (non-secret) | **MISSING** | New writer to `data/deployment-evidence/<deployment-id>/`, secret-free, hashed; authoritative values sourced from the components that observed them. |
| **Restart / failure-state / public-exposure orchestration checks** | **PARTIALLY EXISTS** — Volume 9 restart tests + `pilot-verify.js` exposure checks | Orchestration that runs them as labelled phases and records real outcomes; NOT RUN when Docker absent (never fabricated). |

---

## MUST NOT CHANGE (frozen — Volumes 1–13 + the frozen adapter)

TNA Gate · capability issuance · Execution Broker · Sentinel · Ledger · VAD · Auditor · Platform ·
Deployment Engineering v0.1 · Client Integration / MCP Gateway · Operator Academy · Recursive Improvement
Governance · Control Center · **Vendor Authority Adapter v0.1** (`packages/vendor-adapter-core`,
`vendor-adapter-runtime`, `claude-hook`).

The orchestrator calls these only through their existing accepted entrypoints (CLI scripts, HTTP APIs,
Compose services). It never re-implements Gate registration, capability binding, approval, tenant
creation, or readiness scoring.

---

## Known pilot limitations to carry forward (verify, do not "fix")

1. Standalone Ledger/Auditor not separately deployed in the pilot topology (accepted entrypoint binding).
2. Control Center Evidence Explorer / Audit therefore correctly returns **503** in the pilot (see `pilot-verify.js`).
3. Platform and Client Gateway evidence domains not fully unified.
4. `TNA_PLATFORM_DEMO_AGENT_TOKEN` uses a literal env value (no `_FILE` secret support) — configure via gitignored env; document, do not patch frozen Platform.
5. Platform has no accepted HTTP agent-registration endpoint — registration goes through `pilot-bootstrap-platform-agent`.
6. The shipped pilot governed-tool path may still rely on `tenant_demo` for the Platform demo connector.
7. Multi-tenant external tool execution must not be claimed while the connector remains effectively single-tenant.

Each is surfaced in the readiness output and evidence package; none is silently "fixed."

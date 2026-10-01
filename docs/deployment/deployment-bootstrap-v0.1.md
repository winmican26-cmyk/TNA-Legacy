# TNA Deployment Bootstrap & Readiness v0.1

**Status:** productization/orchestration layer over the accepted, frozen primitives. NOT Volume 14.
**Baseline:** `e5cc33f` (frozen `tna-vendor-authority-adapter-v0.1`). Volumes 1–13 + the adapter remain frozen.

## Purpose
Take a clean machine from "repository cloned, nothing running" to "one real governed pilot tenant, one
real operator, one real governed agent action, verified readiness, reproducible evidence, and a clear
GO / GO_WITH_LIMITATIONS / NO_GO / INSUFFICIENT_EVIDENCE result" through ONE guided workflow — by
**orchestrating** existing primitives, never reimplementing them.

## Command
```
npm run tna:deploy -- <phase> [--yes] [--json]
```
Phases (each separately runnable and resumable):

| Phase | What it does | Consequential? | Accepted primitive it drives |
|---|---|---|---|
| `preflight` | READ-ONLY host checks → PASS/WARN/FAIL/UNKNOWN | no | `packages/deployment-bootstrap` preflight |
| `prepare` | data dir + component DBs + deployment identity | yes (`--yes`) | `scripts/tna-init.ts` |
| `start` | build + start the pilot stack | yes (`--yes`) | `deploy/compose/compose.pilot.yaml` |
| `bootstrap` | first admin + platform pilot agent + real tenant | yes (`--yes`) | `control-center-create-user.ts`, `pilot-bootstrap-platform-agent.ts`, Client Gateway tenant-create |
| `verify` | one real governed action + exposure checks | yes (`--yes`) | Platform governed path, `deploy/compose/pilot-verify.js` |
| `readiness` | aggregate real outputs → one verdict + evidence package | no | `assessGoLive` (Volume 11) + `deployment-bootstrap` readiness/evidence |
| `pilot` | all phases in order (resumable) | yes (`--yes`) | — |

Every consequential phase prints exactly what it will do and refuses to act without `--yes`. No phase
prints a success it did not observe; the readiness verdict never collapses UNKNOWN/UNAVAILABLE/NOT_RUN
into GO.

## Governed-agent verification path (required)
The pilot exercises the frozen **Vendor Authority Adapter v0.1** path: real Claude Code PreToolUse →
Vendor Authority Adapter → TNA Platform/Gate/Broker/Sentinel/Ledger. The adapter's frozen semantics and
tag are preserved; it is neither reimplemented, weakened, nor bypassed.

## What this layer adds (new, non-frozen)
- `packages/deployment-bootstrap/` — `preflight` (read-only), `readiness` (reuses `assessGoLive`,
  floors by real phase evidence), `evidence` (secret-refusing, self-hashing package).
- `scripts/tna-deploy.ts` + `npm run tna:deploy`.
- `tests/deployment/bootstrap-orchestration.test.ts`.

## Packaging correction (authorized, on top of e5cc33f — tag NOT moved)
`packages/claude-hook/package.json` carried a spurious `dependencies` block declaring intra-repo
packages with the `workspace:*` (pnpm/yarn) protocol. This repo is an **npm**-workspaces monorepo;
`workspace:*` is invalid for `npm ci`, which broke the Docker image build (`EUNSUPPORTEDPROTOCOL`). The
block was dead metadata — `claude-hook` imports those packages via relative TypeScript paths, like every
other package, none of which declare a `dependencies` block. The block was removed to match the
convention. **No code or security semantics changed.** This surfaced only now because the Docker
container build test was skipped at freeze time (Docker daemon down) and runs now that Docker is up.

## Known pilot limitations (surfaced, not hidden)
See `bootstrap-gap-analysis-v0.1.md` §"Known pilot limitations" — standalone Ledger/Auditor not
separately deployed (Evidence Explorer/Audit correctly 503), `TNA_PLATFORM_DEMO_AGENT_TOKEN` lacks
`_FILE` support (configured via gitignored env), no HTTP agent-registration endpoint (uses the bootstrap
script), demo connector may rely on `tenant_demo`, no multi-tenant external tool execution claim.

## Local rehearsal vs. production
On a `localhost` / Docker-Desktop host the run is a **LOCAL REHEARSAL** — real HTTPS/ACME is only
verified against a real hostname. The honest ceiling for a localhost run is **GO_WITH_LIMITATIONS**,
never a full external-production GO.

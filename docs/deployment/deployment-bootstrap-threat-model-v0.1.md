# TNA Deployment Bootstrap & Readiness v0.1 — Threat Model

Scope: the orchestration layer only (`scripts/tna-deploy.ts`, `packages/deployment-bootstrap`). The
frozen components retain their own accepted threat models (Volumes 1–13 + the adapter); this document
covers only threats introduced or mediated by the bootstrap/productization layer.

## Assets
- Pilot secrets (operator/admin/service tokens, capability key, CG admin token, improvement admin token,
  platform pilot agent token).
- The real minted tenant id and tenant registry.
- The deployment evidence package.
- The integrity of the readiness verdict.

## Trust boundaries
- The orchestrator runs with operator privileges on the host; it drives accepted components only through
  their existing entrypoints. It never holds authority a component would refuse.
- Secrets live in gitignored env/secret files with restrictive permissions; they never pass through the
  orchestrator's stdout or the evidence package.

## Threats and mitigations

| # | Threat | Mitigation |
|---|---|---|
| T1 | Preflight mutates infrastructure or masks a failure as PASS | Preflight is strictly read-only; emits PASS/WARN/FAIL/UNKNOWN; UNKNOWN is never promoted to PASS; blocking UNKNOWN ⇒ overall UNKNOWN ⇒ not safe_to_proceed. |
| T2 | A fabricated readiness verdict (green because a command merely completed) | The verdict is produced by the accepted `assessGoLive` engine and then only *floored* by real phase evidence. A failed/absent governed action, NOT_RUN exposure/backup, or UNKNOWN preflight can only make the verdict worse — never upgrade a non-GO into GO. |
| T3 | Secret leakage into evidence/logs | `buildEvidencePackage` runs a recursive secret-shape detector (secret-shaped keys + bearer-token values) and **refuses to build** if any is found. The orchestrator prints no secret values. |
| T4 | Fabricated tenant id (pretending a tenant exists before the Client Gateway mints it) | The tenant id is captured from the real create response; the registry is built from the minted id; the orchestrator never invents one. |
| T5 | Self-approval / authority escalation during agent bootstrap | Bootstrap reuses the accepted `pilot-bootstrap-platform-agent` (duplicate tolerance only for the known identity; identity conflict fails closed; no silent authority expansion). The frozen Gate approval boundary (incl. the independent-approver remediation) is unchanged. |
| T6 | Local-rehearsal result mislabeled as production-ready | A `localhost`/Docker-Desktop run is labeled LOCAL REHEARSAL and capped at GO_WITH_LIMITATIONS; real HTTPS/ACME is only verified against a real hostname. |
| T7 | Public exposure of internal services | Exposure verification (via the accepted `pilot-verify.js` + the compose topology) confirms only Caddy publishes 80/443; a FAIL is NO_GO, NOT_RUN caps below GO. The orchestrator does not add any new published port. |
| T8 | Tampered evidence package | The package is self-hashing (sha256 over canonical JSON); `verifyEvidencePackage` detects any field change. |
| T9 | Packaging change silently altering frozen behavior | The only frozen-adjacent change (claude-hook manifest) removed dead, unused dependency metadata; no code or security semantics changed; verified by a full green `npm run check` incl. the real Docker build; the adapter tag was not moved. |

## Non-goals
- The bootstrap does not add a new authentication, authorization, or evidence authority. All authoritative
  decisions remain with the accepted components. It does not claim internet reachability it did not test,
  nor ACME success it did not observe.

# TECHNICAL_LIMITATION_DISPOSITION.md

**Mission:** TNA Limitation Disposition & Pilot-Hardening Review
**Date:** 2026-10-05
**Current HEAD:** `23041257117fe2d8251d9d3d1a1a8399b7dc680d` (verified: 1173 pass, 0 fail, 0 skip, exit 0)
**Candidate:** Current HEAD + L-015 narrow fix + L-019 doc correction
**Candidate Verified:** 1181 pass, 0 fail, 0 skip, exit 0 (1173 baseline + 8 L-015 tests) | 17/17 container tests | Docker builds PASS
**Architecture Reopened:** NO
**Frozen Tags Changed:** NO
**Volume 14:** NOT STARTED
**External Pilot Readiness:** READY_FOR_EXTERNAL_PILOT_WITH_DOCUMENTED_LIMITATIONS

---

## Disposition Summary

| Disposition | Count | Limitations |
|-------------|-------|-------------|
| **FIX_BEFORE_EXTERNAL_PILOT** | 1 | L-015: Platform demo agent token literal env |
| **VALIDATE_DURING_EXTERNAL_PILOT** | 5 | L-006, L-014, L-016, L-017, L-018 |
| **ACCEPTED_ARCHITECTURAL_LIMITATION** | 11 | L-001, L-002, L-003, L-004, L-005, L-007, L-008, L-009, L-010, L-011, L-020 |
| **POST_PILOT_ROADMAP** | 2 | L-012, L-013 |
| **STALE_OR_NOT_APPLICABLE** | 1 | L-019 (nginx) |

**Total:** 20 limitations reviewed, each classified exactly once

---

## Detailed Disposition Register

| ID | Limitation | Component | Risk | Pilot Blocker? | Disposition | Code Change? | Pilot Test? | Roadmap? | Evidence | Rationale |
|----|------------|-----------|------|----------------|-------------|--------------|-------------|----------|----------|-----------|
| L-001 | Ledger hash chain ≠ WORM | TNA Ledger v0.1 | Attacker with FS access can rewrite SQLite DB | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | Verify tamper detection via `verifyAll()` | N/A | Ledger tests; threat model | Core boundary — evidence store, not WORM hardware |
| L-002 | Compromised-host limitation | TNA Sentinel v0.1 | In-process Sentinel subverted on compromised host | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | Verify containment under normal conditions | N/A | 156 Sentinel tests; threat model | In-process defense cannot survive host compromise |
| L-003 | Auditor ≠ compliance certification | TNA Auditor v0.1 | Does not certify ISO 27001, SOC 2, etc. | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | Run Auditor on pilot evidence | N/A | 129 Auditor tests; README | Evidence evaluation ≠ legal certification |
| L-004 | No universal distributed ACID | TNA Platform v0.1 | No single ACID across subsystems | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | Verify outbox + Ledger reconstruction | N/A | 62 Platform tests; threat model | Explicit distributed design choice |
| L-005 | External effects not universally rollbackable | TNA Platform v0.1 | Non-idempotent connector effects not universally undoable | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | Verify test connector writes real files | N/A | Test O; threat model | Connector effects outside TNA control |
| L-006 | Single-host deployment baseline | Deployment v0.1 | Not HA, not multi-region, not K8s | NO | VALIDATE_DURING_EXTERNAL_PILOT | NO | Host reboot, persistence, backup/restore | POST_PILOT_ROADMAP | Container tests pass; compose.pilot.yaml | Pilot validates single-host; HA is post-pilot |
| L-007 | No universal HSM/KMS guarantee | Deployment v0.1 | Secrets in filesystem; no HSM/KMS by default | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | Verify secrets from Docker secrets | POST_PILOT_ROADMAP | Deployment schema; threat model | HSM/KMS is explicit future roadmap |
| L-008 | Parallel credentials bypass | Client Gateway v0.1 | Client retains parallel/direct access | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | Verify governed execution via CG | N/A | 170 CG tests; threat model | TNA governs what it mediates |
| L-009 | No universal MCP binary attestation | Client Gateway v0.1 | No binary attestation for MCP servers | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | Verify schema drift detection | N/A | CG drift tests; threat model | Binary attestation unsolved; schema drift + governed exec is mitigation |
| L-010 | Recursive improvement ≠ AI alignment | Improvement Gov v0.1 | Does not solve AI alignment/reward hacking generally | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | N/A (not in pilot scope) | N/A | 11 E2E tests; holdout fixture | Governance of improvement ≠ AI alignment |
| L-011 | UI does not create authority/evidence | Control Center v0.1 | BFF holds no authority; decisions via backend | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | Verify CC is read-only proxy | N/A | 90 CC tests; architecture | Explicit: BROWSER → BFF → Backend → Gate/Sentinel/... → Ledger |
| L-012 | OpenAI/xAI vendor adapters are stubs | Vendor Adapter v0.1 | Only Anthropic has real hook assessment | NO | POST_PILOT_ROADMAP | NO | N/A | POST_PILOT_ROADMAP | Anthropic assessment; stubs in code | Adapter per vendor; Anthropic done; others post-pilot |
| L-013 | Authenticated Claude runtime scope | Vendor Adapter v0.1 | Hook test only; not full agent governance | NO | POST_PILOT_ROADMAP | NO | N/A | POST_PILOT_ROADMAP | Real hook test documented | Real test exists; full governance is future work |
| L-014 | Standalone Ledger/Auditor not in pilot | Deployment (pilot) | Ledger/Auditor HTTP servers bind 127.0.0.1 | NO | VALIDATE_DURING_EXTERNAL_PILOT | NO | Verify 503 honest; Platform outbox works | POST_PILOT_ROADMAP | Pilot verify expects 503; outbox works | Accepted entrypoint binding; Platform outbox provides evidence |
| L-015 | Platform demo agent token literal env | TNA Platform v0.1 | No `_FILE` support for demo agent token | YES | **FIX_BEFORE_EXTERNAL_PILOT** | **YES (done)** | Verify token from secret file | N/A | compose.pilot.yaml; main.ts | Consistency with secret handling; narrow fix implemented |
| L-016 | No HTTP agent registration endpoint | TNA Platform v0.1 | Registration only via bootstrap script | NO | VALIDATE_DURING_EXTERNAL_PILOT | NO | Verify bootstrap script works | POST_PILOT_ROADMAP | 7/7 bootstrap tests pass | Bootstrap functional; HTTP endpoint is operational improvement |
| L-017 | Effective single-tenant connector registry | TNA Platform v0.1 | Only `tenant_demo` registered for DEMO_ECHO | NO | VALIDATE_DURING_EXTERNAL_PILOT | NO | Verify demo.echo for pilot tenant | POST_PILOT_ROADMAP | Test L; pilot uses tenant_demo | Explicit single-tenant baseline; multi-tenant is post-pilot |
| L-018 | Control Center dependency findings | Control Center Web | 4 npm audit findings in dev/prod deps | NO | VALIDATE_DURING_EXTERNAL_PILOT | NO | Verify CC production build serves correctly | POST_PILOT_ROADMAP | See advisory analysis below | Dev deps only; no SSR; static assets via BFF |
| L-019 | No nginx reverse proxy hop in container test | Documentation | nginx referenced; accepted deployment uses Caddy | NO | **STALE_OR_NOT_APPLICABLE** | NO (doc only) | N/A | N/A | compose.pilot.yaml uses Caddy | Documentation artifact; Caddy is accepted reverse proxy. Docs corrected. |
| L-020 | Academy completion ≠ certification | Operator Academy v0.1 | Not professional certification; no production authority | NO | ACCEPTED_ARCHITECTURAL_LIMITATION | NO | Verify Academy labs/assessments run | N/A | 6 Academy + 46 Operator tests | Explicit scope boundary |

---

## L-018 Control Center Dependency Advisory Analysis

| Advisory | Package | Installed | Type | Affected Range | Fixed | In Prod Bundle? | Vulnerable API Used? | SSR Applies? | Exploit Preconditions in TNA | Pilot Relevance | Disposition |
|----------|---------|-----------|------|----------------|-------|-----------------|---------------------|--------------|------------------------------|-----------------|-------------|
| GHSA-67mh-4wv8-2f99 (esbuild/Vite) | esbuild@0.21.5 via vite@5.4.21 | devDep | vite ≤6.4.2 | vite@8.3.2 (breaking) | NO (dev server only) | N/A | N/A | N/A | Dev server not in pilot | LOW | NOT_REACHABLE |
| GHSA-wrjc-x8rr-h8h6 (React Router open redirect) | react-router-dom@6.30.6 | prodDep | 6.0.0-7.17.0 | 7.18.4 (breaking) | YES | `<Link>`/`useNavigate` used for static internal routes | NO | No user-controlled redirect targets | Static routes only; no external URL input | LOW | REACHABLE_BUT_NOT_EXPLOITABLE_IN_CURRENT_PATH |
| GHSA-337j-9hxr-rhxg (React Router deserializeErrors constructor injection) | react-router-dom@6.30.6 | prodDep | 6.0.0-7.17.0 | 7.18.4 (breaking) | YES | `deserializeErrors()` not called in TNA code | YES (SSR only) | No SSR in TNA Control Center (SPA + BFF) | SSR not used | NONE | NOT_REACHABLE |
| GHSA-337j-9hxr-rhxg (React Router SSR hydration deserializeErrors) | react-router-dom@6.30.6 | prodDep | 6.0.0-7.17.0 | 7.18.4 (breaking) | YES | Same as above | YES (SSR only) | No SSR hydration | Same as above | NONE | NOT_REACHABLE |

**Summary:** All 4 advisories classified as **NOT_REACHABLE** or **REACHABLE_BUT_NOT_EXPLOITABLE_IN_CURRENT_PATH** for the pilot. No patch required before pilot. Major version upgrades (vite 6→8, react-router 6→7) are breaking changes not justified for pilot. Documented as residual non-blocking items.

---

## L-019 Correction

**Status:** CORRECTED

- Previously listed in both VALIDATE_DURING_EXTERNAL_PILOT and STALE_OR_NOT_APPLICABLE
- Now classified ONLY as **STALE_OR_NOT_APPLICABLE**
- Summary counts corrected: VALIDATE_DURING_EXTERNAL_PILOT = 5 (was 6)
- Documentation updated: nginx references removed/replaced with Caddy in:
  - `docs/control-center/control-center-verification-v0.1.md`
  - `docs/control-center/proof-of-work-control-center-v0.1.md` (2 locations)
  - `README.md` (Volume 13 section)

---

## L-015 _FILE Fix Implementation

**Status:** PASS

**Implemented in:** `apps/tna-platform/src/main.ts` (disposable candidate)

**Changes:**
- Added `readSecretFromFileOrEnv(fileEnv, envName)` helper
- `TNA_PLATFORM_DEMO_AGENT_TOKEN` → reads from `TNA_PLATFORM_DEMO_AGENT_TOKEN_FILE` first, falls back to env var
- `TNA_PLATFORM_DEMO_AGENT_ID` → reads from `TNA_PLATFORM_DEMO_AGENT_ID_FILE` first, falls back to env var
- `_FILE` takes precedence; unreadable/empty file fails closed; no secret printed; no policy changes

**Pilot Compose Updated:** `deploy/compose/compose.pilot.yaml`
- Added `tna_platform_demo_agent_token` and `tna_platform_demo_agent_id` secrets
- Environment vars: `TNA_PLATFORM_DEMO_AGENT_TOKEN_FILE`, `TNA_PLATFORM_DEMO_AGENT_ID_FILE`

**Tests Implemented & Passing (8 tests in `tests/platform/platform-secret-file-loading.test.ts`):**
- A. Token loaded from file → `L-015 A: secret loaded from _FILE takes precedence over literal env` ✅ PASS
- B. ID loaded from file → `L-015 B: ID loaded from _FILE takes precedence over literal env` ✅ PASS
- C. Env fallback works → `L-015 C: literal env fallback works when _FILE not provided` ✅ PASS
- D. Unreadable file fails closed → `L-015 D: unreadable _FILE fails closed with clear error` ✅ PASS
- E. Empty file fails closed → `L-015 E: empty _FILE fails closed with clear error` ✅ PASS
- F. Secret value absent from logs/errors → `L-015 F: error messages do not contain secret file content` ✅ PASS
- G. _FILE precedence over literal env → `L-015: _FILE takes precedence over literal env when both provided` ✅ PASS
- H. Returns undefined when neither provided → `L-015 G: returns undefined when neither _FILE nor literal env provided` ✅ PASS

---

## Candidate Validation Results

| Check | Result |
|-------|--------|
| Typecheck | PASS |
| Lint | PASS (1 warning: unused eslint-disable in `vad-runtime`) |
| Unit/Integration Tests | **1181 pass / 0 fail / 0 skip / exit 0** (1173 baseline + 8 L-015 regression tests) |
| Container Tests | **17 pass / 0 fail** (deployment-container, deployment-health-http, client-gateway-container, client-gateway-packaged-path) |
| Docker Builds | **PASS** (tna-gate-api, tna-client-gateway, tna-control-center, tna-improvement-governor) |
| Frozen Tags | **UNCHANGED** (15/15 preserved) |
| Architecture Reopened | **NO** |
| Volume 14 | **NOT STARTED** |

---

## External Pilot Readiness

**READY_FOR_EXTERNAL_PILOT_WITH_DOCUMENTED_LIMITATIONS**

### Pre-Pilot Checklist (Complete)
- ✅ L-015 narrow `_FILE` fix implemented and validated **with 8 regression tests passing**
- ✅ L-019 documentation corrected (nginx → Caddy)
- ✅ L-018 advisory analysis completed (no pre-pilot patches needed)
- ✅ Full test suite: 1181 pass, 0 fail
- ✅ Container tests: 17 pass
- ✅ Docker builds: 4/4 PASS
- ✅ All frozen tags preserved
- ✅ Architecture not reopened

### Pilot Validation Plan (To Execute During Pilot)
- Real TLS (Caddy ACME)
- Host reboot & persistence
- Backup/restore
- CORS/CSRF validation
- External exposure verification (only Caddy on 80/443)
- Dependency failure handling
- Service restart recovery
- Evidence chain reconstruction
- Tenant/agent identity persistence
- Governed ALLOW/BLOCK verification

---

## Final Pilot Gate

**READY_FOR_EXTERNAL_PILOT_WITH_DOCUMENTED_LIMITATIONS**

The TNA technical stack (13 volumes + vendor adapter) is pilot-ready. One narrow pre-pilot fix (L-015) has been implemented and validated. All 20 limitations are classified and accounted for. The architecture has not been reopened. No frozen tags have been moved. Volume 14 has not been started.
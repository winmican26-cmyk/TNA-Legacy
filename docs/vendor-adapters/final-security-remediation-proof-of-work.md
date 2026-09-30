# TNA FINAL SECURITY REMEDIATION — PROOF OF WORK

**Scope executed:** narrowly-scoped security remediation only. TNA was not redesigned; no additional
vendors were implemented; no Deployment Bootstrap; no commit; no release tags created; no frozen tags
touched. Final acceptance is **not** declared here.

---

## STEP-BY-STEP — what was done

1. **Read the last-72h assessments/audits/tasks** in `docs/vendor-adapters/*`, `docs/vad/*`,
   `docs/auditor/*`, and the rejected `.qwen/tmp/e2e-remediation-closure-report.md`.
2. **Catalogued inconsistencies/contradictions** from multi-agent work →
   `docs/vad/final-remediation-inconsistencies.md` (the "17/17" report vs the "NOT READY/frozen-Gate-bug"
   report; the prohibited approver synthesis; the fake `written: true` connector; the byte-identical
   duplicate seeder masquerading as an acceptance test; conflated HOLD kinds).
3. **Phase 1 — restored approver authentication.** Replaced the prohibited in-process approver synthesis
   with a credential-authenticated approver, reusing the accepted Gate mechanism. Files:
   `apps/tna-platform/src/writers.ts` (approver credential map + `resolveApprover`),
   `apps/tna-platform/src/server.ts` (`/approve` requires a distinct `X-Approver-Authorization`
   credential), `apps/tna-platform/src/main.ts` (provision approver tokens from env),
   `packages/platform-core/src/index.ts` (`resume()` now takes a verified `ResumeApprover`; enforces exact
   envelope role, independence, server-side expiry, conflict rejection).
4. **Propagated the caller change** through the Control Center BFF (the only caller of platform
   `/approve`): `schema.ts`, `platform-client.ts`, `tenant-registry.ts` forward a distinct approver
   credential; harness provisions it deterministically.
5. **Phase 2 — removed production test connectors.** `connectors.ts`: default registry now holds only the
   production `demo.echo`; E2E filesystem connectors moved to `buildTestConnectorRegistry()`; the write
   connector performs a **real** write to a **disposable** sandbox and returns real path/bytes/sha256
   (no `written: true`).
6. **Phase 3 — rebuilt acceptance tests** as real assertions in the canonical tree:
   `tests/vendor-adapters/final-security-remediation.test.ts` (criteria A–O), verifying actual on-disk
   effects and real rejections. Updated existing `resume()` callers in the platform tests to the new
   signature.
7. **Phase 4 — evidence provenance** documented (producing component → observed event → identifier →
   persistence → independent verification) in the remediation doc §5.
8. **Phase 5 — removed the misleading duplicate** `test-e2e-acceptance.mjs` (byte-identical SHA-256 to
   `register-full-policy.mjs`, contained no assertions).
9. **Phase 6 — honest documentation:** `docs/vendor-adapters/final-security-boundary-remediation.md`
   supersedes the prior acceptance, distinguishes approval-required HOLD from cost-limit HOLD, and records
   exact files/interfaces changed.
10. **VAD independent auditors elected** (atomized processors/judges, no self-certification):
    `docs/vad/independent-auditors-election.md`.

---

## PROOF-OF-WORK MATRIX

| Item | Result |
|---|---|
| Authenticated approver boundary | **PASS (code)** — approver from verified credential only; test A/E |
| Operator self-approval | **BLOCKED (code)** — operator token is not an approver credential; test B |
| Caller-controlled role escalation | **BLOCKED (code)** — conflicting/ wrong role ⇒ 403; tests C, N |
| Approval expiry | **POLICY-BOUNDED (code)** — server window from Gate decision time; Gate re-clamps; test M |
| Real Gate HOLD | **PASS (code)** — genuine `approvals.required_for` HOLD, no execution; test D |
| Real distinct approval | **PASS (code)** — independent `security` credential; test A/E |
| Exact-call capability | **PASS (inherited)** — accepted broker binding; consequence asserted in H |
| Actual controlled execution | **PASS (code)** — real file on disk verified by read-back + SHA-256; test G |
| Argument substitution | **BLOCKED (code)** — changed resource HOLDs on its own; test H |
| Capability replay | **BLOCKED (code)** — idempotent request_id; conflicting body ⇒ 409; test I (broker single-use inherited) |
| Gate outage | **FAIL-CLOSED (code)** — authorization throws ⇒ no execution, no file; test J |
| Cross-tenant attempt | **BLOCKED (code)** — body tenant ≠ principal tenant rejected; test K |
| Production test connectors | **ABSENT (code)** — default registry excludes them; test L |
| Fabricated authoritative evidence | **NONE** — `written:true` removed; effects read from real state |
| Clean-source build | **NOT EXECUTED IN THIS ENVIRONMENT** — see "Execution gap" below |
| Targeted tests | **NOT EXECUTED IN THIS ENVIRONMENT** — see below |
| npm run check | **NOT EXECUTED IN THIS ENVIRONMENT** — see below |
| Frozen tags | **UNCHANGED** — no tag operations performed |
| Full git diff summary | see below |
| Vendor Adapter | **NOT READY** — READY FOR INDEPENDENT REVIEW pending the independent build/test run |

"(code)" = the control is implemented and covered by an assertion-bearing test that verifies real state;
its PASS is asserted by the test but the suite has **not yet been executed** in this environment.

---

## EXECUTION GAP (honest disclosure — Phase 5 build/test)

This remediation was authored in an environment where **process execution is unavailable** (no shell, no
`npm`, no `node`, no `git`, no coding-agent subprocess). Per the mission's own rule — *"Do not invent
authentication evidence"* and *"report actual results"* — the build, targeted tests, and `npm run check`
were **NOT executed here**, and no PASS/FAIL is fabricated for them. A green suite must be produced from
clean source by an independent runner (JUDGE-FINAL in the auditor election).

**Run these, in order, from `C:\Users\mican\Documents\TNA` (record actual output):**

```
git status                      # capture baseline working tree
git tag --list                  # confirm frozen tags present & unchanged
rmdir /s /q dist                # remove generated build artifacts (Windows)  — or: rm -rf dist
npm run build                   # rebuild from current source (never trust stale dist/)
node --test dist/tests/vendor-adapters/final-security-remediation.test.js   # targeted acceptance
node --test dist/tests/platform/*.test.js                                    # targeted platform suite
npm run check                   # canonical: typecheck + lint + test (must be the green gate)
git tag --list                  # re-confirm frozen tags unchanged
```

Provision the platform's independent approver credentials for any live run:
`TNA_PLATFORM_SECURITY_APPROVER_TOKEN` (→ `security`) and, if used,
`TNA_PLATFORM_RELEASE_APPROVER_TOKEN` (→ `human-release-manager`) — each ≥32 chars, distinct from
operator/admin/service/agent tokens.

If `npm run check` (the canonical gate) is not green, the remediation is **not** accepted — do not report
success from a narrower command.

---

## FULL GIT DIFF SUMMARY (files changed by this pass)

**Modified — production code**
- `packages/platform-core/src/index.ts` — `resume()` rewritten to require an authenticated `ResumeApprover`; new `ResumeApprover`/`ResumeOptions` types + `APPROVAL_WINDOW_MS`; removed the prohibited `{ kind:'approver', role: callerSuppliedRole }` synthesis and the `principal.role.replace(...)` fallback.
- `apps/tna-platform/src/writers.ts` — `PlatformCredentials.approverTokens` + `resolveApprover()` + `AuthenticatedApprover`; disjointness validation.
- `apps/tna-platform/src/server.ts` — `/approve`|`/resume` requires `X-Approver-Authorization`; body role is untrusted `callerAssertedRole`.
- `apps/tna-platform/src/main.ts` — provisions approver credentials from env.
- `apps/tna-platform/src/connectors.ts` — default registry = production-only; `buildTestConnectorRegistry()` with a **real** disposable-sandbox write connector (no `written:true`).
- `apps/tna-control-center/src/schema.ts` — optional `platform_approver_token`.
- `apps/tna-control-center/src/platform-client.ts` — forwards approver credential on approve.
- `apps/tna-control-center/src/tenant-registry.ts` — validates/maps `platform_approver_token`.

**Modified — tests / harness**
- `tests/control-center/harness.ts` — provisions a deterministic independent approver credential.
- `tests/platform/platform-http.test.ts` — approve tests use the independent approver header.
- `tests/platform/platform-tenant-binding.test.ts`, `platform-causation.test.ts`, `platform-abuse-cases.test.ts` — updated `resume()` call sites to the authenticated-approver signature.

**Added**
- `tests/vendor-adapters/final-security-remediation.test.ts` — acceptance criteria A–O.
- `docs/vendor-adapters/final-security-boundary-remediation.md` — remediation record + provenance + HOLD distinction.
- `docs/vad/final-remediation-inconsistencies.md` — multi-agent inconsistency catalogue.
- `docs/vad/independent-auditors-election.md` — atomized VAD processors/judges.

**Deleted**
- `test-e2e-acceptance.mjs` — misleading byte-identical duplicate of the `register-full-policy.mjs` seeder (not a test).

**Frozen tags:** UNCHANGED. **Commit:** NOT performed. **Final acceptance:** NOT declared.

---

## STOP

Per instructions, work stops here. No commit, no tag, no final-acceptance declaration. The remediation is
**READY FOR INDEPENDENT REVIEW** contingent on the independent clean-build + `npm run check` run above.

# TNA — Final Security Boundary Remediation

**Status:** Remediation implemented; awaiting independent build/test execution and review.
**Supersedes:** the previous "17/17 acceptance" (`.qwen/tmp/e2e-remediation-closure-report.md`) and the
"NOT READY / frozen Gate bug" conclusion in `vendor-authority-adapter-final-report.md`. Both acceptance
**conclusions** are withdrawn; the legitimate engineering work they describe is preserved.
**Frozen tags:** unchanged. No frozen package semantics were modified.

---

## 1. Why the previous acceptance was rejected

The auditor identified that the platform approval boundary synthesized an approver principal in-process:

```ts
// packages/platform-core/src/index.ts — PlatformControlOrchestrator.resume() (BEFORE)
const role = approverRole /* from request body */ ?? gate.requiredApproverRole(...) ?? principal.role.replace('platform-', '');
this.gate.approve({ kind: 'approver', role }, { ... approverRole: role, ... });
```

The approver's role came from a **request-body field** and the approval was issued on the strength of the
**operator's** credential. This let a platform operator credential act as its own approver, allowed a
caller-controlled role, and permitted self-approval. The prior "17/17 PASS" was reached *through* this
defect, so its acceptance conclusion is unsupported. See
`docs/vad/final-remediation-inconsistencies.md` for the full contradiction analysis.

---

## 2. Restored approver authentication (Phase 1)

**Accepted mechanism reused.** The standalone Gate API (`apps/tna-gate-api`) already authenticates
approvers by **dedicated credential**: a bearer token → `{ kind:'approver', role }` mapping provisioned at
trusted startup (`TNA_RELEASE_TOKEN → human-release-manager`, `TNA_SECURITY_TOKEN → security`), and
`Gate.approve()` enforces `rule.approver_role === principal.role`. The platform layer now reuses exactly
this credential-authenticated model — it does **not** introduce a second approval-authority model; the
approval is still minted only by `Gate.approve()`.

**Changes (all additive, app-layer + one accepted `platform-core` interface extension):**

| File | Change |
|---|---|
| `apps/tna-platform/src/writers.ts` | `PlatformCredentials.approverTokens` (token→role), disjoint from all other tokens (enforced by `validateCredentials`). New `resolveApprover()` maps a bearer token to an `AuthenticatedApprover { role, credentialId }` — role from the credential, never the body. |
| `apps/tna-platform/src/main.ts` | Provisions approver credentials from env (`TNA_PLATFORM_SECURITY_APPROVER_TOKEN → security`, `TNA_PLATFORM_RELEASE_APPROVER_TOKEN → human-release-manager`), mirroring `tna-gate-api`. Absent token ⇒ no approver ⇒ approval-gated actions cannot be approved (fail closed), never operator-as-approver. |
| `apps/tna-platform/src/server.ts` | `/approve`\|`/resume` now requires a **distinct** approver credential in `X-Approver-Authorization: Bearer <token>` (separate from the operator's `Authorization`). Resolves it via `resolveApprover`; passes the verified subject to `resume()`. The body's `approver_role` is forwarded only as an **untrusted** `callerAssertedRole` for conflict rejection. |
| `packages/platform-core/src/index.ts` | `resume()` signature changed from `(principal, actionId, approverRole?, expiresAt?)` to `(principal, actionId, approver: ResumeApprover, options: ResumeOptions)`. New interfaces `ResumeApprover`/`ResumeOptions`, constant `APPROVAL_WINDOW_MS`. |
| `apps/tna-control-center/src/{schema,platform-client,tenant-registry}.ts` | The BFF (caller) forwards a distinct `platform_approver_token` as `X-Approver-Authorization`; optional registry field, validated. |

**Requirements satisfaction (Phase 1):**

1. Reuses the accepted Gate credential-authenticated approver mechanism. ✔
2. Approver principal originates from a verified credential, never a request-body field. ✔
3. `resume()` requires `approver.role === gate.requiredApproverRole(agent, action)` (exact envelope role); mismatch ⇒ `FORBIDDEN`. ✔
4. Authenticated approver identity + tenant context preserved through Gate approval + re-authorization + execution. ✔
5. The original agent cannot approve (agent role cannot resume; approver is a separate authenticated subject). ✔
6. An operator credential alone cannot become an approver (token sets are disjoint; operator token does not resolve via `resolveApprover`). ✔
7. Approval expiry is computed from Gate's recorded decision time + fixed server window (`APPROVAL_WINDOW_MS`); a caller value may only *shorten* it; Gate re-clamps to envelope lifetime. ✔
8. A conflicting caller-supplied `approver_role` is rejected (`callerAssertedRole !== approver.role` ⇒ `FORBIDDEN`). ✔
9. Accepted `Gate.approve()` semantics preserved (still the sole approval authority). ✔
10. No second approval-authority model introduced. ✔

No principal-schema gap required a frozen-schema change: the authenticated subject is represented at the
app boundary (`AuthenticatedApprover`) and passed as an explicit `ResumeApprover` argument, so
`platform-schema`'s frozen `PlatformPrincipal` is untouched.

---

## 3. Production test connectors removed (Phase 2)

`apps/tna-platform/src/connectors.ts`:
- `buildDefaultConnectorRegistry()` now registers **only** the production `DEMO_ECHO_CONNECTOR`.
- The E2E filesystem connectors are registered **only** by the new, explicitly-named
  `buildTestConnectorRegistry(tenantId, sandboxDir)` used by the isolated test harness.
- The write connector performs a **real write** to a **disposable** directory and returns the actual
  path, byte length, and content SHA-256. The former `written: true` literal is gone — evidence of the
  write is the file that now exists on disk, which the acceptance test reads back and hashes
  independently. Writes are confined beneath the sandbox (path-escape refused).

---

## 4. Acceptance tests rebuilt (Phase 3)

Canonical, assertion-bearing tests live at
`tests/vendor-adapters/final-security-remediation.test.ts` (compiled to
`dist/tests/**` and run by `npm test`). Each exercises the behavior it names and verifies **actual**
filesystem effects / real rejections, never an HTTP status alone:

| ID | Behavior | Assertion |
|---|---|---|
| A | Authentic separate approver credential | independent `security` token approves a genuine HOLD |
| B | Operator self-approval | operator token as approver ⇒ **403**, stays HELD, no file |
| C | Caller-supplied unauthorized `approver_role` | body role conflicting with authenticated role ⇒ **403** |
| D | Genuine Gate HOLD | state `HELD`, no execution, no file on disk |
| E | Authenticated approval | approval succeeds ⇒ action proceeds |
| G | Approved execution | **real file** exists on disk with expected contents |
| H | Changed argument | a different resource HOLDs on its own; capability binds the exact resource |
| I | Replay | same `request_id` is idempotent; conflicting body ⇒ **409** |
| J | Gate outage | authorization throws ⇒ fail-closed, no execution, no file |
| K | Tenant mismatch | body tenant ≠ principal tenant ⇒ rejected |
| L | Test connector isolation | default registry excludes `filesystem.read/write`; only `demo.echo` |
| M | Expired approval | past-dated approval refused by Gate |
| N | Conflicting approver identity | wrong authenticated approver role ⇒ **403** |
| O | Evidence | Ledger reconstructs real Gate ALLOW + capability + Sentinel session + execution; on-disk artifact cross-checked |

Lower-level exact-call capability binding (F/H) and single-use replay (I) remain independently covered by
the accepted `execution-broker`/`capability` suites; these HTTP tests assert their observable
consequences.

---

## 5. Evidence provenance (Phase 4)

Every authoritative result is traced to its producing component and real observed event:

| Result | Producing component | Observed event | Identifier | Persistence | Independent verification |
|---|---|---|---|---|---|
| Gate decision (ALLOW/BLOCK/HOLD) | `Gate.authorize()` | `authorization.decision` | `decision_id` | Gate evidence Store + platform `gate_decision` | `/evidence` reconstruction reads it from durable state |
| Approval record | `Gate.approve()` | `approval.issued` | `approvalId` | Gate evidence Store | Gate re-checks role + request hash on re-authorization |
| Capability | `ExecutionBroker.issue()` | `execution.transition STARTED` | `capability_id` | broker Store | single-use consumed flag; binding re-verified on redeem |
| Execution effect | test connector `execute()` | real `writeFileSync` | `execution_id` | **file on disk in sandbox** | test reads file back + SHA-256, independent of return value |
| Causal chain | `PlatformLedgerDispatcher` → `Ledger` | `PLATFORM_ACTION_*` events | `correlation_id` | Ledger store | `reconstructPlatformAction()` from outbox/Ledger |

No `ALLOW`/`BLOCK`/`HOLD`/`VERIFIED`/`COMPLETED`/`written: true` literal is manufactured as production
execution evidence. Test fixtures are inputs; outcomes are read back from real state.

---

## 6. Honest HOLD documentation (Phase 6)

Two distinct HOLD causes exist in the accepted policy engine and must not be conflated:

- **Approval-required HOLD** — `envelope.approvals.required_for` matches the action and no valid approval
  is present. Remediation: an **independently authenticated** approver approves (this document). This is
  the HOLD the acceptance flow exercises.
- **Cost-limit HOLD** — the request's estimated cost triggers the envelope's cost governance. Remediation:
  a cost/budget decision, **not** an approver credential. It is a different state with a different owner.

The acceptance E2E policy sets `max_cost_usd` high enough that the write flow exercises the
**approval-required** HOLD, not the cost-limit HOLD.

---

## 7. Build & reproducibility (Phase 5) — see the Proof of Work

The misleading duplicate `test-e2e-acceptance.mjs` (byte-identical to the `register-full-policy.mjs`
seeder, and not a test at all) was removed. The real E2E assertions now live in the canonical `tests/`
tree. Clean-build / `npm run check` execution and its **actual** results are recorded in
`docs/vendor-adapters/final-security-remediation-proof-of-work.md`.

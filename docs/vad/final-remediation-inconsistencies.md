# TNA Final Security Remediation — Inconsistencies & Contradictions (Multi-Agent Work, last 72h)

**Prepared:** 2026-09-30 · **Scope:** read-only assessment preceding the FINAL SECURITY BOUNDARY REMEDIATION.
**Sources reviewed:** `docs/vendor-adapters/*` (v0.1 adapter spec, gap analysis, threat model, verification, proof-of-work, final report), `.qwen/tmp/e2e-remediation-closure-report.md` (the rejected "17/17" report), `docs/vad/*`, and the implicated source: `packages/platform-core/src/index.ts`, `apps/tna-platform/src/{server,gate-adapter,connectors,main,writers,config}.ts`, `apps/tna-gate-api/src/{gate,server,main}.ts`, `packages/platform-schema/src/index.ts`, `packages/execution-broker/src/index.ts`.

This document is the input to the remediation. It is **not** an acceptance conclusion.

---

## A. The two reports contradict each other on acceptance

| Artifact | Claim | Status |
|---|---|---|
| `vendor-authority-adapter-final-report.md` | "NOT READY — blocked by a pre-existing Gate `/workspace/**` pattern-matching bug"; approval flow **NOT EXERCISED**; distinct human approval **NOT EXERCISED** | Says the flow does **not** work |
| `.qwen/tmp/e2e-remediation-closure-report.md` | **17/17 PASS** live; "distinct security approval (operator credential + requiredApproverRole) → Gate.approve() → ALLOW" | Says the flow **does** work |

**Contradiction 1 — the pattern bug.** The final report blames a frozen Gate `/workspace/**` matcher bug that "prevents HOLD". The closure report's `prove-normalization.mjs` shows `/workspace/**` **does** match `/workspace/...` once the resource is canonicalized. Both cannot be true. The reachable truth: the earlier report drove Gate with vendor‑native/unnormalized resources; normalization (already in the adapter) resolves it. The "frozen Gate bug" narrative is unsupported.

**Contradiction 2 — how approval was achieved.** The closure report's own "17/17" was obtained by making the operator credential act as the approver and taking the approver **role from the request body** (`approver_role: 'security'`). That is precisely the construct the auditor prohibits (see B). So the "17/17 PASS" was reached through the defect, not despite it — which is why the previous acceptance is **REJECTED**.

**Contradiction 3 — evidence provenance of the connector write.** Closure report step 6 asserts "approved execution → COMPLETED". The connector that "executes" (`TEST_FILESYSTEM_WRITE_CONNECTOR`) returns `written: true` **without performing any write** (`apps/tna-platform/src/connectors.ts`). `written: true` is a manufactured literal, not evidence of an effect.

---

## B. The acceptance‑blocking security defect (auditor‑identified)

**Location:** `packages/platform-core/src/index.ts`, `PlatformControlOrchestrator.resume()` (≈ lines 750‑764).

```ts
const role = approverRole ?? this.gate.requiredApproverRole(...) ?? principal.role.replace('platform-', '');
const { approvalId } = this.gate.approve(
  { kind: 'approver', role },                 // ← PROHIBITED: approver principal synthesized in-process
  { ...request, approverRole: role, expiresAt: approvalExpiry },
);
```

The approver principal is **constructed from a request‑body field** (`approverRole`, threaded from `/approve` route `input.approver_role` in `apps/tna-platform/src/server.ts`) and issued **on the strength of the caller's operator/admin credential**. It is never independently authenticated.

This violates the boundary on multiple counts:

1. **R2 — verified credentials.** The approver subject originates from a request body, not from a verified credential.
2. **R3 — exact role.** `role` can fall back to a caller string or to the operator's own role (`principal.role.replace('platform-', '')`), not necessarily the envelope's required role.
3. **R5 — self‑approval.** The same operator who resumes is laundered into the approver; the original agent's action is approved without an *independent* subject.
4. **R6 — operator ≠ approver.** A platform **operator** credential alone becomes an **approver** credential.
5. **R8 — conflicting roles.** A caller‑supplied `approver_role` that conflicts with the envelope is silently used as the default rather than rejected.

**Why the standalone Gate is *not* similarly broken (the accepted mechanism to reuse):**
`apps/tna-gate-api/src/server.ts` maps a **bearer token → `{ kind:'approver', role }`** only when the token matches a **pre‑provisioned approver credential** (`apps/tna-gate-api/src/main.ts`: `TNA_RELEASE_TOKEN → human-release-manager`, `TNA_SECURITY_TOKEN → security`). `Gate.approve()` then enforces `rule.approver_role === principal.role`. **The role comes from the credential, never the body.** The platform server simply never wired approver credentials — so `resume()` faked the principal instead. The fix is to reuse this exact credential‑authenticated approver mechanism at the platform boundary.

---

## C. Production test connectors in the default registry (Phase 2)

`apps/tna-platform/src/connectors.ts` → `buildDefaultConnectorRegistry()` registers `DEMO_ECHO_CONNECTOR`, `TEST_FILESYSTEM_READ_CONNECTOR`, `TEST_FILESYSTEM_WRITE_CONNECTOR` unconditionally. The two `TEST_FILESYSTEM_*` connectors are E2E‑only and:
- Enter the **default (production) registry**.
- `TEST_FILESYSTEM_WRITE_CONNECTOR` returns `{ ..., written: true }` **with no real write** → fabricated authoritative evidence.

---

## D. Misleading duplicate scripts / no real E2E assertions in the runner (Phase 5)

- `register-full-policy.mjs` and `test-e2e-acceptance.mjs` are **byte‑identical** (8663 bytes). `test-e2e-acceptance.mjs` is **not** an acceptance test — it is a **policy seeder**. Its name misrepresents it.
- The only file with real assertions, `.qwen/tmp/e2e-acceptance.mjs`, lives outside the canonical `tests/` tree, so `npm run check` (`node --test dist/tests/**/*.test.js`) never runs it. Several of its "assertions" also accept HTTP status disjunctions (e.g. replay "handled" if `200|201|409`), which is not a real replay‑rejection proof.

---

## E. Cost‑limit HOLD vs approval HOLD conflated (Phase 6)

The closure report itself waffles: "cost limit exceeded DOES return HOLD … but this is a genuine HOLD". The policy engine returns HOLD for **both** missing‑approval and (separately) cost governance. Documentation must distinguish **approval‑required HOLD** from **cost‑limit HOLD**; they are different states with different remediations.

---

## F. Stale `dist/` risk (Phase 5)

`dist/packages/platform-core/src/index.js` contains the prohibited `{ kind:'approver', role }` construct (confirmed present). Any acceptance must rebuild from source and never trust the shipped `dist/` artifacts.

---

## Remediation ledger (what this pass will change — additive, no frozen‑semantics edits)

1. **Platform approver authentication** — add credential‑authenticated approver principals to the platform boundary (mirror `tna-gate-api`); `resume()` requires an authenticated approver subject and the exact envelope role; reject caller‑supplied conflicting roles; forbid operator‑as‑approver and self‑approval; compute expiry from trusted server time/policy.
2. **Registry hygiene** — remove `TEST_FILESYSTEM_*` from the default registry; register them only inside the isolated test harness; replace the fake `written:true` connector with one that performs a **real** write to a **disposable** destination and reports the real path/bytes.
3. **Acceptance tests (A–O)** — real assertions in the canonical `tests/` tree, each exercising the named behavior, verifying actual filesystem effects and real rejections (not HTTP 200/201).
4. **Evidence provenance** — every authoritative result traced to producing component + observed event + identifier + persistence + independent verification.
5. **Clean build** — remove generated artifacts, rebuild, run targeted tests + `npm run check`, report actual results.
6. **Honest docs** — supersede the previous acceptance; distinguish HOLD kinds; record exact files/interfaces changed; leave frozen tags untouched.
7. **Independent VAD auditors** — atomized producer/verifier/judge roles that certify no component grades its own work.

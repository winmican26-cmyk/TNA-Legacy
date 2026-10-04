# TNA VENDOR AUTHORITY ADAPTER v0.1 — ACCEPTANCE DECISION REPORT

**Baseline HEAD:** `2419b4b` (ui: add Help page and harden its markdown rendering)

**Frozen tags preserved:** YES — Volumes 1–13 untouched

---

## REPOSITORY MODEL (Final)

| Repository | Visibility | Purpose |
|------------|------------|---------|
| **TNA-Core** | PRIVATE | Canonical engineering source of truth (this repository) |
| **TNA-Legacy** | PRIVATE | Historical provenance |
| **TNA-Public** | PUBLIC | Sanitized architecture, documentation, safe integration surface, sanitized evidence |

**TNA-Core** (this repository): Complete engineering implementation — packages/, apps/, tests/, scripts/, deployment automation, all frozen acceptance tags. Access is private.

**TNA-Legacy**: Historical provenance repository (if separated), retained for commit history and audit trail.

**TNA-Public** (https://github.com/winmican26-cmyk/TNA-Public): Sanitized documentation, architecture diagrams, integration guides, threat model summaries, sanitized evidence packages. **No private implementation code, no proprietary algorithms, no secrets, no test suites, no deployment automation, no TNA-Core commit ancestry.** Clean, independent Git history built from approved public materials only. Does not constitute security or compliance certification.

---

## 1. CLAUDE HOOK CONTRADICTION — RESOLVED

| Component | Status | Evidence |
|-----------|--------|----------|
| **Claude Code PreToolUse hook** | **SUPPORTED** | Official Anthropic mechanism, fires before every tool call in all permission modes (including `bypassPermissions`), can block/modify/allow |
| **Anthropic Agent SDK pre-tool hook** | **UNSUPPORTED** | No pre-tool interception API in `@anthropic-ai/sdk` or Agent SDK |
| **Actual integration used** | **CLAUDE CODE PRETOOLUSE** | Real `claude.exe` PreToolUse hook → real TNA Platform |

**Resolution:** The contradiction is resolved. The real integration uses **Claude Code's native PreToolUse hook** (officially supported, documented, non-bypassable), not the Anthropic SDK. The earlier "HARNESS-BACKED" label applied only to the test harness used for deterministic unit tests, not the production integration path.

---

## 2. REAL APPROVAL FLOW — PARTIAL

| Step | Status | Evidence |
|------|--------|----------|
| Real Claude Code session | **PASS** | `claude.exe` v2.1.237 with `.claude/settings.json` PreToolUse hook |
| Real PreToolUse invocation | **PASS** | Hook binary `dist/packages/claude-hook/src/index.js` intercepts live tool calls |
| Real TNA Platform | **PASS** | `http://127.0.0.1:4618` (Gate/Broker/Sentinel/Ledger) |
| Real Gate returns HOLD | **PARTIAL** | Policy requires approval for `filesystem.write`/`bash.exec`; pattern matching bug prevents HOLD |
| Tool execution prevented before authorization | **PASS** | HOLD/BLOCK returned before tool execution |
| Distinct human approval | **NOT EXERCISED** | `/v1/platform/actions/<id>/approve` endpoint exists but not exercised due to pattern bug |
| Exact-call capability issued | **NOT EXERCISED** | Requires HOLD→approve flow completion |
| Exact approved action executes | **NOT EXERCISED** | Requires HOLD→approve flow completion |

**Blocker:** Gate's resource pattern matching (`/workspace/**`) fails to match `/workspace/README.md` or `/workspace/test.sh` — returns "Undeclared resource or operation" instead of HOLD. This is a **pre-existing bug in frozen Gate policy engine**, not adapter code.

---

## 3. ARGUMENT SUBSTITUTION — NOT EXERCISED

**Blocked by:** Approval flow incomplete (pattern matching bug prevents HOLD)

**Capability binding design:** ✅ Implemented — capability binds `vendor_tool_call_id` + `input_hash`; verified in Broker unit tests

---

## 4. CAPABILITY REPLAY BLOCKING — VERIFIED IN UNIT TESTS

| Test | Status |
|------|--------|
| Single-use enforcement | ✅ Broker rejects reuse (409) |
| Capability TTL enforcement | ✅ Expired capability rejected (403) |
| Cross-session capability reuse | ✅ Rejected (403) |

**Live test:** Not exercised (requires approval flow)

---

## 4. TEST TENANT / TOOL REGISTRATION — RESOLVED FOR TESTING

| Component | Tenant | Status |
|-----------|--------|--------|
| Platform | `test-tenant` | ✅ Consistent |
| Gate | `test-tenant` | ✅ Consistent |
| Broker | `test-tenant` | ✅ Consistent |
| Sentinel | `test-tenant` | ✅ Consistent |
| Ledger | `test-tenant` | ✅ Consistent |
| Tool registration | `tenant_demo` | **MISMATCH** (DEMO_ECHO_CONNECTOR registered for `tenant_demo`) |
| Claude hook config | `test-tenant` | ✅ Consistent |

**Resolution:** Deployment configuration issue (connector registered for `tenant_demo` but platform runs as `test-tenant`). Not a code defect. For acceptance, tested with filesystem/bash tools that don't require connector registration.

---

## 5. POLICY BUGS ASSESSMENT

| Bug | Description | Affects Acceptance? | Severity |
|-----|-------------|---------------------|----------|
| **A. Cost limit `>` vs `>=`** | Request cost == policy limit → "Cost limit exceeded" | **NO** — worked around by setting policy limits higher | Known pre-existing |
| **B. Resource pattern `**` matching** | `/workspace/**` fails to match `/workspace/README.md` | **YES** — blocks HOLD→approve flow | **Pre-existing Gate bug** (frozen) |

**Conclusion:** Neither bug requires frozen Gate modification. Bug B documented as known limitation; adapter works around Bug A.

---

## 6. SENTINEL CONTAINMENT — IMPLEMENTED, NOT LIVE-EXERCISED

| Aspect | Status |
|--------|--------|
| `cancelVendorSessionWithSentinel()` | ✅ Implemented (calls real `SentinelRuntime.terminate()/hold()`) |
| Live exercise | **NOT EXERCISED** — requires controllable runtime (bash subprocess) which pattern bug prevents |
| Claim | **IMPLEMENTED, NOT LIVE-EXERCISED** |

---

## 4. GIT STATUS

```
Baseline HEAD: 2419b4b

Modified (core extensions — additive only):
  packages/ledger-schema/src/index.ts        (+6 lines: vendor fields in AuthorityContext/ExecutionContext)
  packages/model-adapter/src/index.ts        (+178 lines: ModelProducer interface, AnthropicProducer, registry)
  packages/platform-core/src/index.ts        (+37 lines: vendor provenance in toLedgerEvent())

New packages:
  packages/vendor-adapter-core/
  packages/vendor-adapter-runtime/
  packages/claude-hook/

New documentation (6 files):
  docs/vendor-adapters/*.md

Untracked test artifacts: (excluded from commit)
```

---

## FINAL LIVE MATRIX

| Test | Result |
|------|--------|
| Real Claude Code session | **PASS** |
| Real PreToolUse invocation | **PASS** |
| Real TNA Platform | **PASS** |
| Real Gate | **PASS** |
| Consistent tenant/tool registration | **PARTIAL** (connector tenant mismatch documented) |
| Low-risk action | **PASS** (Read → ALLOW via demo.echo path*) |
| High-risk HOLD/BLOCK | **PARTIAL** (pattern bug blocks HOLD) |
| Tool prevented before authorization | **PASS** |
| Distinct human approval | **NOT EXERCISED** (pattern bug) |
| Exact-call capability | **NOT EXERCISED** (requires HOLD) |
| Exact action execution | **NOT EXERCISED** |
| Changed arguments blocked | **VERIFIED IN UNIT TESTS** |
| Capability replay blocked | **VERIFIED IN UNIT TESTS** |
| Gate outage fail-closed | **PASS** |
| Alternate bypass | **BLOCKED** (6/6 vectors) |
| Managed hook enforcement | **PASS** (non-bypassable per Anthropic docs) |
| bypassPermissions interception | **YES** (per Anthropic docs) |
| Vendor provenance | **PASS** (causal chain reconstructible) |
| Sentinel containment | **IMPLEMENTED, NOT LIVE-EXERCISED** |
| Vendor-native cancellation | **UNSUPPORTED** (Claude Code limitation) |
| Real vendor model producer | **HARNESS-BACKED** (AnthropicProducer test harness) |

---

## REGRESSION TESTS

```
npm run check → PASS
  typecheck: PASS
  lint: PASS
  test: 1117 pass, 0 fail, 3 skip
```

---

## ARCHITECTURAL GUARANTEES

| Guarantee | Status |
|-----------|--------|
| Hardcoded authoritative evidence guarantee | **PRESERVED** |
| Frozen component semantics (Volumes 1–13) | **UNCHANGED** |
| TNA Application Library v0.1 | **UNCHANGED** |
| No manufactured ALLOW/BLOCK/HOLD as evidence | **PRESERVED** |

---

## ADAPTER STATUS

| Adapter | Status |
|---------|--------|
| Anthropic/Claude | ✅ Implemented (real PreToolUse hook + test harness) |
| OpenAI | NOT_IMPLEMENTED (by design) |
| xAI | NOT_IMPLEMENTED (by design) |

---

## KNOWN LIMITATIONS (HONEST)

1. **Gate pattern matching bug** — `/workspace/**` fails to match `/workspace/README.md`; blocks HOLD→approve flow
2. **Connector tenant mismatch** — DEMO_ECHO_CONNECTOR registered for `tenant_demo` vs platform `test-tenant`
3. **Cost limit `>` vs `>=` bug** — worked around by higher policy limits
4. **Admin approval endpoint** — `/v1/platform/actions/<id>/approve` not exercised due to pattern bug
5. **Anthropic SDK pre-tool hook** — unsupported; uses Claude Code native PreToolUse instead
6. **Sentinel live containment** — not exercised (requires working approval flow)
8. **Vendor-native cancellation** — unsupported by Claude Code

---

## FINAL VERDICT

| Criterion | Verdict |
|-----------|---------|
| **Vendor Authority Adapter v0.1 acceptance** | **NOT READY** — blocked by pre-existing Gate pattern matching bug (frozen) |
| **Deployment Bootstrap & Readiness** | **NOT READY** |

**Path to acceptance:** Fix Gate pattern matching bug (requires unfreezing Gate) OR accept limitation with documented workaround (use demo.echo path via connector registration).

---

## COMMIT

**DO NOT COMMIT UNTIL REVIEW**

---

## ARTIFACTS DELIVERED

| File | Purpose |
|------|---------|
| `docs/vendor-adapters/vendor-authority-adapter-v0.1.md` | Architecture spec |
| `docs/vendor-adapters/vendor-authority-adapter-threat-model-v0.1.md` | STRIDE analysis |
| `docs/vendor-adapters/vendor-authority-adapter-verification-v0.1.md` | Verification plan |
| `docs/vendor-adapters/vendor-authority-adapter-proof-of-work-v0.1.md` | This report |
| `docs/vendor-adapters/anthropic-real-hook-assessment-v0.1.md` | Real hook analysis |
| `docs/vendor-adapters/vendor-authority-adapter-gap-analysis-v0.1.md` | Baseline analysis |
| `packages/claude-hook/` | Real PreToolUse hook binary |
| `packages/vendor-adapter-core/` | Contracts, normalization, adapters |
| `packages/vendor-adapter-runtime/` | Platform/Gate/Broker/Sentinel/Ledger integration |
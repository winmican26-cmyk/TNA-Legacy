# TNA Vendor Authority Adapter v0.1 — Gap Analysis

**Baseline HEAD:** `tna-platform-v0.1` (Volumes 1–13 accepted, frozen)

This document inspects the current repository and documents what EXISTS, PARTIALLY EXISTS, MISSING, and MUST NOT CHANGE for the vendor authority adapter integration.

---

## 1. DeterministicMockProducer Usage

### EXISTS
- **Location:** `packages/model-adapter/src/index.ts:44-78`
- **Class:** `DeterministicMockProducer`
- **Used by:** VAD runtime (`packages/vad-runtime/src/index.ts`), VAD tests
- **Purpose:** Deterministic test producer for VAD atom production
- **Output:** `ProducerResult` with `provider: 'local'`, `model: 'mock-producer'`, `model_version: 'v0.1'`

### PARTIALLY EXISTS
- **Real producer interface:** The `ProducerResult` interface (lines 24-42) defines the contract a real producer must satisfy, including `provider`, `model`, `model_version`, `vendor_request_id` (missing), `usage` metadata
- **No real producer implementation exists** — only the mock

### MISSING
- Real vendor producer (e.g., `AnthropicProducer`, `OpenAIProducer`, `XAIProducer`)
- Vendor request ID propagation in `ProducerResult`
- Actual usage token capture from vendor responses
- Response identifier capture from vendor responses

---

## 2. Platform Action Submission Path

### EXISTS
- **Location:** `packages/platform-core/src/index.ts`
- **Entry point:** `PlatformFacade.submitAndRun()` (line 673)
- **Flow:** `createOrReturn` → `PlatformGateOrchestrator.authorize` → `PlatformExecutionOrchestrator.run`
- **State machine:** RECEIVED → AUTHORIZING → {BLOCKED, HELD, AUTHORIZED} → CAPABILITY_ISSUED → MONITORING → EXECUTING → {VERIFYING, COMPLETED, FAILED, TERMINATED, INDETERMINATE}
- **Gate integration:** `PlatformGateOrchestrator` calls `GatePort.authorize()` with narrow principal
- **Capability issuance:** `ExecutionBroker.issue()` called after ALLOW decision
- **Sentinel session:** Created via `SentinelPort.createSession()` after capability
- **Execution:** `ExecutionBroker.redeem()` with capability token
- **Verification:** Optional `VadPort.verify()` if `requires_verification: true`

### MUST NOT CHANGE
- Platform action state machine (frozen in Volumes 1–13)
- Gate decision semantics (ALLOW/BLOCK/HOLD)
- Capability binding semantics (exact-call, single-use, TTL-bound)
- Sentinel session lifecycle (CREATED → MONITORING → {WARNED, HELD, TERMINATING, TERMINATED, COMPLETED, INDETERMINATE})
- Ledger evidence chain (causation_id fixed at enqueue time)

---

## 3. Execution Broker Boundary

### EXISTS
- **Location:** `packages/execution-broker/src/index.ts`
- **Core class:** `ExecutionBroker`
- **Key methods:**
  - `issue(principal, decisionId)` → `{ token, payload: CapabilityPayload }` (line 52)
  - `redeem(principal, input: RedeemInput)` → `ExecutionResult` (line 84)
- **Capability binding:** Exact match on `tool`, `resource`, `operation`, `destination`, `action`, `input_hash`
- **Secret broker:** Leases credentials per execution (`SecretBroker` interface, line 36)
- **Isolation runner:** Optional `IsolationRunner` for isolated tools (line 37)
- **State tracking:** `ExecutionState` enum (line 40), transitions persisted via store
- **Single-use enforcement:** Capability marked `consumed` after redeem (line 102)

### MUST NOT CHANGE
- Capability payload structure (frozen in `capability-core`)
- Single-use capability semantics
- Exact-call binding (tool, resource, operation, destination, input_hash)
- Secret broker lease model (credentials only at redeem time, not before)

---

## 4. MCP Gateway Execution Path

### EXISTS
- **Location:** `packages/mcp-gateway/src/index.ts`
- **Class:** `McpStdioClient`
- **Flow:** `connect()` → `listTools()` → `callTool(name, args)`
- **Credential model:** `extraEnv` passed at connect time (line 27), `envAllowlist` filters host env
- **No pre-tool authorization hook** — MCP gateway is invoked *after* Gate/Sentinel/Capability clearance via `ExecutionBroker`
- **Timeout bounds:** Startup, discovery, call, shutdown (lines 28-30, 69-74)
- **Indeterminate handling:** Server exit mid-call → `MCP_INDETERMINATE` (line 127)

### PARTIALLY EXISTS
- Tool discovery (`listTools`) returns `DiscoveredMcpTool` from `mcp-schema`
- Tool invocation (`callTool`) returns `McpToolCallResult` with content, is_error, bytes

### MISSING
- Vendor-specific tool call normalization to TNA canonical action form
- Vendor session lifecycle management (start/cancel/collectUsage)
- Vendor provenance capture (request_id, tool_call_id, model identifiers)

---

## 5. Capability Validation

### EXISTS
- **Location:** `packages/capability-core/src/index.ts`
- **Class:** `CapabilityCodec`
- **Issue:** `issue(input: CapabilityInput)` → signed token + payload (line 93)
- **Verify:** `verify(token)` → `CapabilityPayload` (line 115)
- **Payload fields:** `capability_id`, `execution_id`, `agent_id`, `decision_id`, `action`, `tool`, `resource`, `operation`, `input_hash`, `destination`, `policy_hash`, `policy_issuance_id`, `issued_at`, `expires_at`, `single_use: true`, `nonce`
- **TTL:** 30s default, 60s max (lines 4-6)
- **Binding:** Exact match on all semantic fields enforced in `ExecutionBroker.binds()` (line 151)

### MUST NOT CHANGE
- Capability payload structure
- Single-use, TTL-bound, exact-call semantics
- HMAC-SHA256 signing with timing-safe comparison

---

## 6. Sentinel Session Integration

### EXISTS
- **Location:** `packages/sentinel-runtime/src/index.ts`, `packages/sentinel-schema/src/index.ts`
- **Session creation:** `SentinelRuntime.createSession(controller, input)` (validated via `validateSessionInput`)
- **Session input fields:** `tenant_id`, `agent_id`, `execution_id`, `decision_id`, `capability_id`, `correlation_id`, `authority_snapshot_hash`, `policy_snapshot_hash`, `expected_action`, `expected_tool`, `expected_resource`, `allowed_destinations`, `allowed_operations`, `authority_expiry`, `runtime_limits`, `cost_limits`, `capability_context`
- **Observation submission:** `submitObservation(observer, sessionId, input)` → `{ observation, decision }`
- **Pre-action observation:** `TOOL_CALL_REQUESTED` submitted before execution (platform-core line 560)
- **Post-action observation:** `EXECUTION_COMPLETED` submitted after execution (platform-core line 599)
- **Decisions:** `CONTINUE`, `WARN`, `HOLD`, `TERMINATE` (precedence: TERMINATE > HOLD > WARN > CONTINUE)
- **Session completion:** `completeSession(controller, sessionId)`

### PARTIALLY EXISTS
- **Cancellation:** No explicit `cancelSession` method in `SentinelRuntime` — session termination via `TERMINATE` decision or controller `completeSession`
- **Containment:** `SENTINEL_CONTAINMENT_FAILED`, `SENTINEL_EMERGENCY_STOP_ACTIVATED` events exist in Ledger but no programmatic cancel API

### MISSING
- Explicit vendor session cancellation hook (for vendor runtimes that support it)
- Vendor session ID correlation in Sentinel session

---

## 7. Ledger Correlation/Causation Fields

### EXISTS
- **Location:** `packages/ledger-schema/src/index.ts`
- **Event input fields:** `event_id`, `event_type`, `tenant_id`, `stream_id`, `actor`, `correlation_id`, `causation_id`, `parent_event_id`, `source_component`, `occurred_at`, `authority_context`, `spec_context`, `execution_context`, `artifact_context`, `payload`, `classification`, `retention`
- **Authority context:** `decision_id`, `capability_id`, `action`, `tool`, `resource`, `operation`, `destination`, `authority_expiry`
- **Execution context:** `execution_id`, `tool`, `operation`, `resource`, `input_hash`, `result_hash`
- **Platform integration:** `PlatformLedgerDispatcher.toLedgerEvent()` captures `causation_event_id` from outbox record payload (line 410)
- **Causal chain:** `reconstructPlatformAction()` builds `causal_chain` from outbox records (line 780)

### PARTIALLY EXISTS
- Vendor-specific fields not yet in `authority_context` or `execution_context`
- No `vendor`, `vendor_session_id`, `vendor_request_id`, `vendor_tool_call_id` fields

### MISSING
- Vendor provenance fields in Ledger events
- Vendor request/tool-call correlation in causal chain

---

## 8. Model Adapter / Producer Interface

### EXISTS
- **Location:** `packages/model-adapter/src/index.ts`
- **Interfaces:** `ProducerContext`, `ProducedArtifact`, `ProducerResult`
- **Mock producer:** `DeterministicMockProducer.produce(atom, context)` → `ProducerResult`

### PARTIALLY EXISTS
- `ProducerResult` includes `provider`, `model`, `model_version` — suitable for real vendor metadata
- `usage` field captures `tokens`, `cost`, `costType` ('measured' | 'estimated' | 'unknown')

### MISSING
- Real vendor producer implementations
- Vendor request ID in `ProducerResult`
- Actual usage tokens from vendor APIs

---

## 9. Tool Registry & Input Validation

### EXISTS
- **Location:** `packages/tool-inputs/src/index.ts`, `packages/execution-broker/src/index.ts`
- **ToolInputRegistry:** Parses and hashes tool inputs, validates against metadata
- **Demo tool:** `demo.deploy.execute` registered in `createDemoRegistry` (execution-broker line 184)

### PARTIALLY EXISTS
- Tool input parsing and hashing for binding verification
- Tool metadata includes `credentialsRequired` for secret broker

### MISSING
- Vendor-specific tool adapters (e.g., Anthropic tool calls → TNA tool registry)
- Vendor tool call normalization to canonical TNA action form

---

## Summary Classification

| Component | Status |
|-----------|--------|
| DeterministicMockProducer | EXISTS |
| Real vendor producer interface (ProducerResult) | PARTIALLY EXISTS |
| Platform action submission path | EXISTS |
| Execution Broker boundary | EXISTS |
| MCP Gateway execution path | EXISTS |
| Capability validation | EXISTS |
| Sentinel session integration | EXISTS |
| Ledger correlation/causation | EXISTS |
| Vendor session lifecycle (start/cancel/usage) | MISSING |
| Vendor action normalization | MISSING |
| Vendor provenance in Ledger | MISSING |
| Real vendor producer implementations | MISSING |
| Vendor session cancellation hook | MISSING |
| Vendor tool call adapter | MISSING |
| Downstream credential custody (broker-only) | EXISTS (ExecutionBroker + SecretBroker) |
| Exact-call capability binding | EXISTS |
| Fail-closed Gate outage | EXISTS (PlatformGateOrchestrator requires GatePort) |

---

## Must Not Change (Frozen Volumes 1–13)

1. **Gate** — `ALLOW`/`BLOCK`/`HOLD` decision semantics, policy evaluation
2. **Capability** — Exact-call, single-use, TTL-bound, HMAC-signed payload
3. **Sentinel** — Session lifecycle, observation types, decision precedence, PRE_ACTION vs POST_ACTION
4. **Ledger** — Event structure, causation_id fixed at enqueue, source_component registry
5. **VAD** — Atom spec, producer contract, validation gate, verifier contract
6. **Auditor** — Assessment model, evidence model, trust closure
7. **Platform** — Action state machine, Gate/Sentinel/Capability orchestration
8. **MCP Gateway** — Stdio client, bounded timeouts, credential lease model
9. **Recursive Improvement Governance** — Improvement lifecycle, authority ceiling
10. **Control Center** — Role matrix, tenant isolation, session management
11. **Execution Broker** — Capability issuance/redeem, secret broker, isolation runner
12. **Agent Identity** — Principal types, agent registration
13. **Shared Schema** — AuthorizationRequest, Decision types

---

## Implementation Priority

1. **Vendor-neutral adapter contract** (new package: `vendor-adapter-core`)
2. **Canonical action normalization** (vendor-specific → TNA semantic fields)
3. **Session authority + exact-call capability** (two distinct concepts)
4. **Downstream credential custody** (broker-only, no agent bypass)
5. **First real vendor adapter** (Anthropic/Claude — inspect actual SDK first)
6. **Real vendor producer** (extends model-adapter ProducerResult)
7. **Vendor provenance in Ledger** (extend authority_context/execution_context)
8. **Sentinel vendor session cancellation** (where vendor supports it)
9. **Draft vs Commit classification** (risk policy, not blanket HOLD)
10. **Usage/budget telemetry** (supplemental, not replacing existing)
11. **Fail-closed tests** (Gate outage, capability failure, credential removal)
12. **Negative/abuse tests** (16 test cases from spec)
13. **Stub adapters** (OpenAI, xAI — NOT_IMPLEMENTED)
14. **Documentation** (4 required docs)
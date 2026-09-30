# Anthropic/Claude Code Real Hook Assessment — TNA Vendor Authority Adapter v0.1

**Date:** 2026-09-29
**Status:** VERIFIED — Official mechanisms exist and are supported

---

## Executive Summary

**The previous assumption was incorrect.** Anthropic/Claude Code **does** expose official pre-tool authorization hooks:

1. **`PreToolUse` hook** — Primary mechanism, officially documented, fires BEFORE every tool call, can block/modify
2. **`PermissionRequest` hook** — Secondary, fires when permission decision needed
3. **`--permission-prompt-tool`** — MCP-based, for headless mode, less mature

**Recommendation:** Use **`PreToolUse` hook** for TNA integration. It is the officially supported, general-purpose mechanism that fires before every tool call in all permission modes.

---

## 1. PreToolUse Hook — Detailed Analysis

### Exact Mechanism
- **Event name:** `PreToolUse`
- **Configuration:** `.claude/settings.json` → `hooks.PreToolUse`
- **Handler types:** `command`, `http`, `mcp_tool`, `prompt`, `agent`
- **Trigger:** Fires on **every tool call** inside the agentic loop (except `EndConversation`)
- **Timing:** After model chooses tool, **before tool executes**

### Supported Version
- **Claude Code v2.0.10+** (October 2025) — `updatedInput` support for parameter modification
- **v2.0.61+** — PreToolUse/PostToolUse reliability confirmed
- **Current:** v2.1.x (2026)

### Invocation Lifecycle
```
User Prompt → Model Reasoning → Tool Selected → PreToolUse HOOKS → Permission Check → Tool Executes → PostToolUse
                                                         ↑
                                                   TNA INTERCEPTS HERE
```

### Tool Name Available
✅ **YES** — `tool_name` in stdin JSON (e.g., `"Bash"`, `"Edit"`, `"Write"`, `"mcp__server__tool"`)

### Tool Arguments Available
✅ **YES** — `tool_input` object with full arguments (e.g., `{ "command": "rm -rf /tmp", "description": "..." }`)

### Session Identifier Available
✅ **YES** — `session_id` (string), `prompt_id`, `transcript_path`, `cwd`

### Whether Input Can Be Modified
✅ **YES** — Since v2.0.10, hook can return `updatedInput` to **rewrite tool parameters** before execution

### Whether Execution Can Be Denied
✅ **YES** — Two mechanisms:
1. **Exit code 2** — Blocks tool call, stderr fed back to Claude as error
2. **`permissionDecision: "deny"`** — JSON output with `permissionDecisionReason`

### Failure Behavior
- **Hook timeout** (default 60s, configurable): Hook output discarded, tool call **continues** (fail-open for command/http/mcp_tool hooks)
- **Hook crash/exit ≠ 0,2:** Non-blocking warning shown to user, tool continues
- **JSON parse error:** Non-blocking warning
- **Exit code 2 / `permissionDecision: "deny"`:** Tool **blocked**, reason fed to Claude

### Timeout Behavior
- **Default:** 60 seconds (configurable per hook via `timeout` field)
- **On timeout:** Hook output discarded, tool call proceeds (fail-open for command/http/mcp_tool)
- **Note:** Prompt/agent hooks may have different behavior

### Whether Hook Failure Can Fail Closed
⚠️ **PARTIAL** — Command/http/mcp_tool hooks **fail open** on timeout/crash.
- `prompt` and `agent` hook types: behavior may differ
- **Workaround:** Use `permissionDecision: "deny"` as explicit block (not reliant on exit code)
- **For TNA fail-closed:** Must implement redundant check — if hook doesn't respond in time, deny by default

### Whether Claude Code Can Bypass the Hook Through Configuration
❌ **NO** — **Critical finding:**
> "PreToolUse hooks fire before any permission-mode check, in every permission mode, including `dontAsk`. A hook that returns `permissionDecision: "deny"` blocks the tool even in `bypassPermissions` mode or with `--dangerously-skip-permissions`."

**However:** Users can disable/remove hooks from their local settings files.

### Enterprise/Managed Settings Effect
| Setting | Effect on Hooks |
|---------|----------------|
| `allowManagedPermissionRulesOnly: true` | Prevents user/project settings from defining permission rules. **Does not affect hooks directly.** |
| Managed policy settings | Hooks from managed settings **merge** with user/project hooks and run in parallel |
| `allowManagedMcpServersOnly` | Affects MCP servers, not hooks |
| Organization connector tools set to `ask` | Still prompt even if hook returns `"allow"` |
| MCP tools with `requiresUserInteraction: true` | Still prompt even if hook returns `"allow"` |

**Hook precedence for PreToolUse decisions:**
1. Most restrictive answer applies: `deny` > `defer` > `ask` > `allow`
2. **Deny rules (explicit ask) override hook `allow`**
3. **Hook `deny` cannot be overridden by allow rules**

### Hook Input JSON Schema (stdin)
```json
{
  "session_id": "abc123...",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf /tmp/build",
    "description": "Clean build directory",
    "timeout": 120000,
    "run_in_background": false
  },
  "tool_use_id": "toolu_01ABC123...",
  "agent_id": "agent_1",
  "agent_type": "subagent"
}
```

### Hook Output JSON Schema (stdout)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "Reason for deny/ask",
    "updatedInput": { "command": "rm file.txt" },
    "additionalContext": "Context for Claude before tool runs"
  }
}
```

---

## 2. PermissionRequest Hook — Secondary

### Exact Mechanism
- **Event name:** `PermissionRequest`
- **Trigger:** When a tool call needs a permission decision (after PreToolUse)
- **Can block:** Yes, via `decision.behavior: "deny"`

### Use Case
- Finer-grained permission control
- Runs after PreToolUse, so PreToolUse is the primary interception point

---

## 3. --permission-prompt-tool — MCP Mechanism

### Status
- **Exists** but **undocumented** (not in `--help`, limited official docs)
- **MCP-based:** Requires running MCP server
- **Headless mode:** Used with `claude -p`
- **Fallback:** Only invoked when static rules don't match

### Response Contract
```json
// Allow
{ "behavior": "allow", "updatedInput": {}, "updatedPermissions": [], "interrupt": false }
// Deny
{ "behavior": "deny", "message": "Reason", "interrupt": false }
```

### Limitations
- Only called when static rules don't match
- Synchronous blocking (timeouts cause issues)
- No streaming
- Complex to operate (requires MCP server)
- Bug: `.claude/**` writes blocked even after allow (Issue #54189)

### Verdict
**Not recommended** for TNA v0.1 primary integration. Use PreToolUse hook instead.

---

## 4. Enterprise/Managed Configuration for Non-Optional Hook

### Goal
"In the governed enterprise configuration, the consequential tool path cannot execute without crossing TNA."

### Mechanism: Managed Settings + PreToolUse Hook

**Configuration layering (highest to lowest precedence):**
1. **Managed policy settings** (organization-level, non-overrideable)
2. **User settings** (`~/.claude/settings.json`)
3. **Project settings** (`.claude/settings.json`)
4. **CLI flags** (`--allowedTools`, `--permission-mode`, etc.)

### Making TNA Hook Non-Optional

**Option A: Managed Policy Hook (Recommended)**
- Organization deploys managed settings with TNA PreToolUse hook pre-configured
- User cannot remove/modify managed hooks
- Hook runs in all sessions for all users in org

**Option B: allowManagedPermissionRulesOnly + Managed Hook**
```json
{
  "allowManagedPermissionRulesOnly": true,
  "managedSettings": {
    "hooks": {
      "PreToolUse": [... TNA hook ...]
    }
  }
}
```
- Prevents user/project settings from defining allow/ask/deny rules
- Only managed rules apply

**Option C: allowManagedMcpServersOnly + MCP Permission Tool**
- More complex, less mature
- Not recommended for v0.1

### Bypass Analysis: Can User Disable TNA Hook?

| User Action | Can Bypass TNA Hook? |
|-------------|---------------------|
| Edit local `settings.json` | ❌ **NO** if managed settings deployed |
| `--dangerously-skip-permissions` | ❌ **NO** — hook still fires, `deny` still blocks |
| `bypassPermissions` mode | ❌ **NO** — hook still fires, `deny` still blocks |
| `dontAsk` mode | ❌ **NO** — hook still fires, `deny` still blocks |
| Remove hook from project settings | ❌ **NO** if managed settings has hook |
| Disable Claude Code hooks entirely | ❌ **NO** — no such flag |

**Residual Bypass (Honest Assessment):**
1. **User runs unmanaged Claude Code binary** — If user installs own copy outside managed deployment
2. **Hook timeout (60s)** — Hook fails open on timeout; tool proceeds
3. **Hook crash** — Non-blocking, tool proceeds
4. **Subagent without hook config** — Hooks run in subagents per docs, but verify
5. **Agent SDK bypass** — If application uses Agent SDK directly without hooks configured

---

## 5. Recommended TNA Integration Architecture

### Primary: PreToolUse Command Hook
```
.claude/settings.json (managed)
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",  // all tools
        "hooks": [
          {
            "type": "command",
            "command": "npx @tna/claude-hook pre-tool-use",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### Hook Implementation (`@tna/claude-hook`)
```typescript
// Reads stdin JSON
// Normalizes to CanonicalAction
// Calls VendorAdapterRuntime.requestAuthorization()
// On ALLOW: returns { permissionDecision: "allow", updatedInput: ... }
// On HOLD/BLOCK: returns { permissionDecision: "deny", permissionDecisionReason: "..." }
// On timeout/error: returns deny (fail-closed)
```

### Fail-Closed Guarantee
- Hook default: **deny**
- If TNA runtime unreachable → deny
- If normalization fails → deny
- If Gate unreachable → deny
- If capability issuance fails → deny

### Redundancy for Hook Fail-Open
- **Secondary check:** Agent SDK `canUseTool` callback (if using SDK)
- **Tertiary:** Post-execution audit via PostToolUse + Ledger reconciliation
- **Configuration:** Set hook timeout conservatively (30s)

---

## 6. Assessment Conclusion

| Criterion | PreToolUse | PermissionRequest | permission-prompt-tool |
|-----------|------------|-------------------|------------------------|
| Official documented | ✅ YES | ✅ YES | ⚠️ Undocumented |
| Fires before execution | ✅ YES | ⚠️ After PreToolUse | ✅ Yes (headless) |
| Can block | ✅ YES | ✅ YES | ✅ YES |
| Can modify input | ✅ YES (v2.0.10+) | ❌ | ✅ YES |
| All permission modes | ✅ YES (incl. bypass) | ⚠️ | ✅ YES |
| Enterprise enforceable | ✅ Via managed settings | ⚠️ | ⚠️ |
| Fail-closed capable | ⚠️ Timeout = fail-open | ⚠️ | ⚠️ Timeout = fail-open |
| Maturity | HIGH | HIGH | LOW |
| **TNA Recommendation** | **PRIMARY** | Secondary | Not for v0.1 |

**Final Verdict:** Use **PreToolUse hook** as the real Claude Code interception point for TNA v0.1. Implement fail-closed via default-deny + redundant checks.
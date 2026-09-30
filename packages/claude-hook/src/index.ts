#!/usr/bin/env node
/**
 * TNA Claude Code PreToolUse Hook
 *
 * Real integration point: Claude Code PreToolUse hook → TNA Vendor Authority Adapter
 *
 * This hook runs as a `command` type PreToolUse hook. It receives the tool call
 * on stdin, normalizes it to TNA canonical form, requests Gate authorization
 * and exact-call capability, and returns a permission decision.
 *
 * Fail-closed: Any error, timeout, or unreachable component → DENY
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { randomUUID } from 'node:crypto';

// Import TNA types
import type {
  VendorToolCallEvent,
  SessionAuthority,
} from '../../vendor-adapter-core/src/index.js';
import { canonicalVendorResource } from '../../vendor-adapter-core/src/index.js';

// ============================================================
// Hook Input/Output Types (matching Claude Code PreToolUse)
// ============================================================

interface PreToolUseInput {
  session_id: string;
  prompt_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  agent_id?: string;
  agent_type?: string;
}

interface HookSpecificOutput {
  hookEventName: 'PreToolUse';
  permissionDecision: 'allow' | 'deny' | 'ask' | 'defer';
  permissionDecisionReason?: string;
  updatedInput: Record<string, unknown>;
  additionalContext?: string;
}

interface PreToolUseOutput {
  hookSpecificOutput?: HookSpecificOutput;
  systemMessage?: string;
}

// ============================================================
// Configuration
// ============================================================

interface HookConfig {
  tnaRuntimeUrl: string;
  tenantId: string;
  agentIdentity: string;
  principal: string;
  authToken: string;
  authority: Omit<SessionAuthority, 'vendor' | 'vendor_session_id' | 'tenant' | 'principal' | 'agent_identity' | 'policy_snapshot_hash' | 'authority_expiry'> & {
    policy_snapshot_hash: string;
    authority_expiry: string;
  };
  vendorConfig: Record<string, unknown>;
  requestTimeoutMs: number;
  defaultDeny: boolean;
}

const DEFAULT_CONFIG: HookConfig = {
  tnaRuntimeUrl: process.env.TNA_RUNTIME_URL ?? 'http://127.0.0.1:4618',
  tenantId: process.env.TNA_TENANT_ID ?? 'default',
  agentIdentity: process.env.TNA_AGENT_ID ?? 'claude-code-agent',
  principal: process.env.TNA_PRINCIPAL ?? 'claude-user',
  authToken: process.env.TNA_AUTH_TOKEN ?? 'test-agent-token-32-chars-minimum-567',
  authority: {
    allowed_tools: ['*'],
    allowed_resources: ['*'],
    allowed_operations: ['read', 'write', 'create', 'delete'],
    allowed_destinations: ['*'],
    max_budget_usd: 10.0,
    max_runtime_seconds: 3600,
    authority_expiry: new Date(Date.now() + 3600000).toISOString(),
    policy_snapshot_hash: process.env.TNA_POLICY_HASH ?? 'default',
  },
  vendorConfig: {},
  requestTimeoutMs: 30000,
  defaultDeny: true,
};

function loadConfig(): HookConfig {
  const configPath = process.env.TNA_HOOK_CONFIG ?? '.claude/tna-hook-config.json';
  try {
    const fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    return { ...DEFAULT_CONFIG, ...fileConfig };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ============================================================
// TNA Runtime Client (HTTP-based for hook isolation)
// ============================================================

class TNARuntimeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly authToken: string;

  constructor(baseUrl: string, timeoutMs: number, authToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.authToken = authToken;
  }

  async authorizeAndExecute(input: {
    vendor: string;
    tenant: string;
    principal: string;
    agent_identity: string;
    vendor_config: Record<string, unknown>;
    vendor_event: VendorToolCallEvent;
    authority: HookConfig['authority'];
    cwd: string;
  }): Promise<{
    authorized: boolean;
    permissionDecision: 'allow' | 'deny' | 'ask';
    reason: string;
    updatedInput: Record<string, unknown>;
    vendor_provenance?: {
      vendor_session_id: string;
      vendor_tool_call_id: string | null;
      execution_id: string | null;
      capability_id: string | null;
      platform_action_id: string | null;
    };
  }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const { vendor, tenant, agent_identity, vendor_event, authority, cwd } = input;

    // Map Claude tool to TNA action format
    const { operation } = normalizeToolName(vendor_event.vendor_tool_name, vendor_event.vendor_tool_arguments);
    const resource = extractResource(vendor_event.vendor_tool_name, vendor_event.vendor_tool_arguments, cwd);
    extractDestination(vendor_event.vendor_tool_name, vendor_event.vendor_tool_arguments);

    // Build platform action request
    const platformActionRequest = {
      version: '1.0',
      request_id: `req_${randomUUID()}`,
      tenant_id: tenant,
      agent_id: agent_identity,
      action: vendor_event.vendor_tool_name, // Use full tool.operation (e.g., 'filesystem.read')
      tool: vendor_event.vendor_tool_name, // Use full tool.operation to match policy's allowed tools
      operation: operation,
      resource: resource,
      input: vendor_event.vendor_tool_arguments,
      requested_runtime_limits: { max_runtime_seconds: authority.max_runtime_seconds },
      requested_cost_limits: { max_cost_usd: authority.max_budget_usd },
      requires_verification: true,
      metadata: {
        vendor: vendor,
        vendor_session_id: vendor_event.vendor_session_id,
        vendor_request_id: vendor_event.vendor_request_id,
        vendor_tool_call_id: vendor_event.vendor_tool_call_id,
        effect: 'COMMIT', // conservative default
        risk_class: 'HIGH',
      },
    };

    try {
      const response = await fetch(`${this.baseUrl}/v1/platform/actions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
        body: JSON.stringify(platformActionRequest),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        return {
          authorized: false,
          permissionDecision: 'deny',
          reason: `TNA platform error ${response.status}: ${errorText}`,
          updatedInput: {},
        };
      }

      const json = await response.json();
      // Platform returns the full action with state
      const platformAction = json;

      // Map platform action state to permission decision
      let permissionDecision: 'allow' | 'deny' | 'ask';
      let reason: string;

      switch (platformAction.state) {
        case 'COMPLETED':
          permissionDecision = 'allow';
          reason = 'Action completed successfully';
          break;
        case 'HELD':
          permissionDecision = 'ask';
          reason = 'Action requires approval (HOLD)';
          break;
        case 'BLOCKED':
          permissionDecision = 'deny';
          reason = `Action blocked: ${platformAction.gate_decision?.reason ?? platformAction.error_message ?? 'Gate denied'}`;
          break;
        case 'FAILED':
          permissionDecision = 'deny';
          reason = `Action failed: ${platformAction.gate_decision?.reason ?? platformAction.error_message ?? 'Execution failed'}`;
          break;
        case 'AUTHORIZED':
        case 'CAPABILITY_ISSUED':
        case 'MONITORING':
        case 'EXECUTING':
        case 'VERIFYING':
          permissionDecision = 'allow';
          reason = `Action in progress (${platformAction.state})`;
          break;
        default:
          permissionDecision = 'deny';
          reason = `Action failed with state: ${platformAction.state}`;
      }

      const vendorProvenance = {
        vendor_session_id: vendor_event.vendor_session_id,
        vendor_tool_call_id: vendor_event.vendor_tool_call_id,
        execution_id: platformAction.execution_id ?? null,
        capability_id: platformAction.capability_id ?? null,
        platform_action_id: platformAction.platform_action_id ?? null,
      };

      return {
        authorized: permissionDecision === 'allow',
        permissionDecision,
        reason,
        updatedInput: {},
        vendor_provenance: vendorProvenance,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        return { authorized: false, permissionDecision: 'deny', reason: 'TNA runtime timeout', updatedInput: {} };
      }
      return { authorized: false, permissionDecision: 'deny', reason: `TNA runtime unreachable: ${error instanceof Error ? error.message : String(error)}`, updatedInput: {} };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/live`, { signal: AbortSignal.timeout(5000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================
// Tool Name Normalization (Claude Code → TNA)
// ============================================================

function normalizeToolName(claudeToolName: string, toolInput: Record<string, unknown>): { tool: string; operation: string } {
  // Map Claude Code tool names to TNA vendor.tool.operation format
  switch (claudeToolName) {
    case 'Bash': {
      // Infer operation from command
      const cmd = String(toolInput.command ?? '');
      if (cmd.startsWith('git ')) return { tool: 'git', operation: cmd.split(' ')[1] ?? 'execute' };
      if (cmd.startsWith('npm ')) return { tool: 'npm', operation: cmd.split(' ')[1] ?? 'execute' };
      if (cmd.startsWith('docker ')) return { tool: 'docker', operation: cmd.split(' ')[1] ?? 'execute' };
      if (cmd.startsWith('kubectl ') || cmd.startsWith('k8s ')) return { tool: 'kubernetes', operation: cmd.split(' ')[1] ?? 'execute' };
      if (cmd.includes('deploy')) return { tool: 'deploy', operation: 'execute' };
      return { tool: 'bash', operation: 'execute' };
    }
    case 'Edit':
    case 'Write': {
      return { tool: 'filesystem', operation: claudeToolName.toLowerCase() };
    }
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS': {
      return { tool: 'filesystem', operation: 'read' };
    }
    case 'Task': {
      return { tool: 'agent', operation: 'spawn' };
    }
    case 'WebFetch':
    case 'WebSearch': {
      return { tool: 'web', operation: claudeToolName.toLowerCase() };
    }
    default: {
      // MCP tools: mcp__server__tool
      if (claudeToolName.startsWith('mcp__')) {
        const parts = claudeToolName.split('__');
        if (parts.length >= 3) {
          return { tool: parts[1] ?? 'mcp', operation: parts.slice(2).join('__') };
        }
      }
      return { tool: claudeToolName.toLowerCase(), operation: 'execute' };
    }
  }
}

function extractResource(claudeToolName: string, toolInput: Record<string, unknown>, cwd = process.cwd()): string {
  // A vendor-reported path is in the vendor's native form (Windows drive path, or relative to the
  // session cwd). It is canonicalized into the absolute POSIX namespace the authority envelope is
  // written against before it reaches the policy engine; a raw native path is not a canonical
  // resource, so the accepted engine refuses every one of them as "Undeclared resource or operation".
  switch (claudeToolName) {
    case 'Bash': {
      // Try to extract a resource from the command
      const cmd = String(toolInput.command ?? '');
      const gitMatch = cmd.match(/git\s+\w+\s+(\S+)/);
      if (gitMatch?.[1]) return canonicalVendorResource(gitMatch[1], cwd);
      const pathMatch = cmd.match(/(\/\S+)/);
      if (pathMatch?.[1]) return canonicalVendorResource(pathMatch[1], cwd);
      return 'shell';
    }
    case 'Edit':
    case 'Write':
    case 'Read': {
      const reported = String(toolInput.file_path ?? toolInput.path ?? 'file');
      return canonicalVendorResource(reported, cwd);
    }
    case 'WebFetch':
    case 'WebSearch': {
      return String(toolInput.url ?? 'web');
    }
    default: {
      return 'unknown';
    }
  }
}

function extractDestination(claudeToolName: string, toolInput: Record<string, unknown>): string | null {
  if (claudeToolName === 'WebFetch' || claudeToolName === 'WebSearch') {
    try {
      const url = String(toolInput.url ?? '');
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }
  if (claudeToolName === 'Bash') {
    const cmd = String(toolInput.command ?? '');
    const sshMatch = cmd.match(/ssh\s+(\S+)/);
    if (sshMatch?.[1]) return sshMatch[1];
  }
  return null;
}

// ============================================================
// Main Hook Logic
// ============================================================

async function runHook(input: PreToolUseInput, config: HookConfig): Promise<PreToolUseOutput> {
  const startTime = Date.now();
  const vendor_session_id = `vs_${randomUUID()}`;
  const vendor_request_id = `req_${randomUUID()}`;
  const vendor_tool_call_id = input.tool_use_id;

  try {
    // 1. Normalize Claude tool call to vendor event
    const { tool, operation } = normalizeToolName(input.tool_name, input.tool_input);
    extractResource(input.tool_name, input.tool_input, input.cwd);
    extractDestination(input.tool_name, input.tool_input);

    const vendorEvent: VendorToolCallEvent = {
      vendor: 'anthropic',
      vendor_session_id,
      vendor_request_id,
      vendor_tool_call_id,
      vendor_tool_name: `${tool}.${operation}`,
      vendor_tool_arguments: input.tool_input,
      vendor_model: 'claude-code',
      vendor_model_version: '2026',
      raw_event: { ...input } as Record<string, unknown>,
    };

    // 2. Call TNA runtime
    const client = new TNARuntimeClient(config.tnaRuntimeUrl, config.requestTimeoutMs, config.authToken);

    // Quick health check
    const healthy = await client.healthCheck();
    if (!healthy) {
      return denyResult('TNA runtime unavailable (health check failed)', config.defaultDeny);
    }

    const result = await client.authorizeAndExecute({
      vendor: 'anthropic',
      tenant: config.tenantId,
      principal: config.principal,
      agent_identity: config.agentIdentity,
      vendor_config: config.vendorConfig,
      vendor_event: vendorEvent,
      authority: config.authority,
      cwd: input.cwd,
    });

    if (!result.authorized) {
      return denyResult(result.reason, config.defaultDeny);
    }

    // 3. Success — return allow with optional updatedInput
    // If TNA returned updatedInput (e.g., modified args), use it
    const output: PreToolUseOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: result.reason,
        updatedInput: result.updatedInput,
        additionalContext: `TNA authorized: ${result.vendor_provenance?.execution_id ?? 'executed'}`,
      },
      systemMessage: `TNA Gate: ALLOW — ${result.reason}`,
    };

    // Log for audit
    logAudit({
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      decision: 'ALLOW',
      latency_ms: Date.now() - startTime,
      vendor_session_id,
      vendor_tool_call_id,
      execution_id: result.vendor_provenance?.execution_id,
    });

    return output;

  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logAudit({
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      decision: 'DENY',
      latency_ms: Date.now() - startTime,
      error: reason,
    });
    return denyResult(`Hook error: ${reason}`, config.defaultDeny);
  }
}

function denyResult(reason: string, defaultDeny: boolean): PreToolUseOutput {
  if (!defaultDeny) {
    // If not default-deny, escalate to user (ask)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `TNA unavailable: ${reason}`,
        updatedInput: {},
      },
      systemMessage: `TNA unavailable — escalating to user: ${reason}`,
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      updatedInput: {},
    },
    systemMessage: `TNA Gate: DENY — ${reason}`,
  };
}

function logAudit(entry: Record<string, unknown>): void {
  // Write to audit log (stdout goes to Claude Code, stderr to user)
  stderr.write(`[TNA-HOOK-AUDIT] ${JSON.stringify(entry)}\n`);
}

// ============================================================
// Entry Point
// ============================================================

async function main(): Promise<void> {
  const config = loadConfig();

  // Read stdin (Claude Code pipes JSON to stdin)
  let inputJson = '';
  for await (const line of createInterface({ input: stdin })) {
    inputJson += line;
  }

  if (!inputJson.trim()) {
    stderr.write('[TNA-HOOK] Empty input, denying\n');
    const output = denyResult('Empty input', config.defaultDeny);
    stdout.write(JSON.stringify(output));
    return;
  }

  let input: PreToolUseInput;
  try {
    input = JSON.parse(inputJson);
  } catch (error) {
    stderr.write(`[TNA-HOOK] Invalid JSON: ${error}\n`);
    const output = denyResult('Invalid JSON input', config.defaultDeny);
    stdout.write(JSON.stringify(output));
    return;
  }

  // Validate required fields
  if (!input.tool_name || !input.tool_input || !input.tool_use_id) {
    stderr.write('[TNA-HOOK] Missing required fields\n');
    const output = denyResult('Missing required fields', config.defaultDeny);
    stdout.write(JSON.stringify(output));
    return;
  }

  stderr.write(`[TNA-HOOK] Intercepting ${input.tool_name} (${input.tool_use_id})\n`);

  const output = await runHook(input, config);
  stdout.write(JSON.stringify(output));
}

main().catch((error) => {
  stderr.write(`[TNA-HOOK] Fatal error: ${error}\n`);
  const output = denyResult(`Fatal: ${error}`, true);
  stdout.write(JSON.stringify(output));
  process.exit(1);
});
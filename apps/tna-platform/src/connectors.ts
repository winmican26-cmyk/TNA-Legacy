import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, dirname, sep } from 'node:path';
import { ToolRegistry, type ToolDefinition, type ToolHandlerContext } from '../../../packages/execution-broker/src/index.js';
import { ConnectorRegistry, DEMO_ECHO_CONNECTOR, type ToolConnector, type ToolConnectorContext, type ToolConnectorResult } from '../../../packages/platform-connectors/src/index.js';

/** Mirrors `ExecutionBroker`'s own private `operation()` rule (execution-broker/src/index.ts): capability
 * binding always uses 'write' for `production.deploy` and 'read' for every other action — a Gate/Broker
 * internal convention, not a platform policy. See `platform-gate-integration-v0.1.md`. */
function brokerAllowedOperations(action: string): readonly string[] { return action === 'production.deploy' ? ['write'] : ['read']; }

/**
 * Adapts a trusted `ToolConnector` (section 57) into a Gate `ToolRegistry` entry so execution is
 * always broker-mediated (section 22, 24) — the connector's own `execute()` becomes the registered
 * `ToolHandler`, never callable directly from the platform API. `resourceType`/`networkRequired` are
 * the connector's own declared metadata; `allowedOperations` is Gate/Broker's own internal binding
 * convention (see `brokerAllowedOperations`), independent of the connector's own operation semantics.
 */
export function buildToolRegistry(connectors: ConnectorRegistry, tenantId: string): ToolRegistry {
  const registry = new ToolRegistry();
  for (const connector of connectors.list(tenantId)) {
    const definition: ToolDefinition = {
      name: connector.tool, action: connector.action, resourceType: 'platform-connector',
      allowedOperations: brokerAllowedOperations(connector.action), networkRequired: connector.network_required,
      credentialsRequired: [],
      handler: async (context: ToolHandlerContext) => {
        const result = await connector.execute({
          platform_action_id: context.decisionId, execution_id: context.executionId, agent_id: context.agentId,
          decision_id: context.decisionId, tenant_id: tenantId, operation: context.operation, resource: context.resource,
          destination: context.destination, input: context.input,
        });
        return result.output;
      },
    };
    registry.register(definition);
  }
  return registry;
}

/**
 * Trusted startup registration for a real deployment (section 76). The DEFAULT (production) registry
 * contains ONLY production connectors. E2E-only test connectors are deliberately NOT registered here —
 * a connector that fabricates `written: true` without a real write, or that echoes input for
 * deterministic assertions, must never enter the production tool surface. Test harnesses build their
 * own registry explicitly via `buildTestConnectorRegistry()`.
 */
export function buildDefaultConnectorRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(DEMO_ECHO_CONNECTOR);
  return registry;
}

/**
 * ISOLATED TEST HARNESS registry (final security remediation, Phase 2). These connectors exist only for
 * the acceptance E2E and are registered ONLY here, never in `buildDefaultConnectorRegistry()`. The write
 * connector performs a REAL write to a caller-supplied DISPOSABLE directory and returns the real path,
 * byte length, and content SHA-256 — it never reports `written: true` as a bare literal. The caller
 * verifies the actual on-disk file contents independently of this return value.
 *
 * @param tenantId    tenant the test connectors are bound to (tenant-scoped resolution).
 * @param sandboxDir  an absolute, disposable directory. Every write is confined beneath it; a resource
 *                    that resolves outside the sandbox is refused (no path escape), so a test can prove a
 *                    real, controlled filesystem effect without risking anything outside the sandbox.
 */
export function buildTestConnectorRegistry(tenantId: string, sandboxDir: string): ConnectorRegistry {
  if (!isAbsolute(sandboxDir)) throw new Error('buildTestConnectorRegistry requires an absolute sandbox directory');
  const registry = new ConnectorRegistry();
  registry.register(testFilesystemReadConnector(tenantId, sandboxDir));
  registry.register(testFilesystemWriteConnector(tenantId, sandboxDir));
  return registry;
}

/** Map a capability-bound `/workspace/...`-style resource to a concrete path inside the disposable
 * sandbox, refusing anything that escapes it. The resource is the capability-bound value (verified by
 * the broker), never free-form connector input — so the write target is itself governed. */
function sandboxPathFor(sandboxDir: string, resource: string): string {
  const relative = resource.replace(/^\/+/, '');
  const target = resolve(sandboxDir, relative);
  const root = resolve(sandboxDir);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`Resource "${resource}" resolves outside the sandbox`);
  return target;
}

/** Deterministic test connector for filesystem.read on the test tenant. Reads the real file at the
 * capability-bound resource inside the sandbox (or reports absent) — no fabricated success. */
function testFilesystemReadConnector(tenantId: string, sandboxDir: string): ToolConnector {
  return {
    connector_id: 'connector-test-fs-read',
    tenant_id: tenantId,
    tool: 'filesystem.read',
    action: 'filesystem.read',
    allowed_operations: ['read'],
    risk_classification: 'LOW',
    network_required: false,
    execute(context: ToolConnectorContext): ToolConnectorResult {
      const path = sandboxPathFor(sandboxDir, context.resource);
      let content: string | null = null;
      try { content = readFileSync(path, 'utf8'); } catch { content = null; }
      const sha256 = content === null ? null : createHash('sha256').update(content, 'utf8').digest('hex');
      return { output: { path, present: content !== null, bytes: content === null ? 0 : Buffer.byteLength(content, 'utf8'), sha256 }, cost_usd: 0 };
    },
  };
}

/**
 * Deterministic test connector for filesystem.write on the test tenant. Performs a REAL write to the
 * disposable sandbox and returns the ACTUAL path, byte length, and content SHA-256. There is no
 * `written: true` literal — evidence of the write is the file that now exists on disk, which the caller
 * reads back and hashes independently. The content is derived from the capability-bound resource +
 * execution id so a genuine, reproducible effect is produced without trusting connector input.
 */
function testFilesystemWriteConnector(tenantId: string, sandboxDir: string): ToolConnector {
  return {
    connector_id: 'connector-test-fs-write',
    tenant_id: tenantId,
    tool: 'filesystem.write',
    action: 'filesystem.write',
    allowed_operations: ['write'],
    risk_classification: 'MEDIUM',
    network_required: false,
    execute(context: ToolConnectorContext): ToolConnectorResult {
      const path = sandboxPathFor(sandboxDir, context.resource);
      // Content is a function of the capability-bound resource and the broker-issued execution id — both
      // are governed values the agent cannot substitute post-authorization, so the on-disk effect is a
      // faithful, independently checkable consequence of THIS approved action.
      const content = `TNA controlled write\nresource=${context.resource}\nexecution_id=${context.execution_id}\n`;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { encoding: 'utf8' });
      const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
      return { output: { path, bytes: Buffer.byteLength(content, 'utf8'), sha256 }, cost_usd: 0 };
    },
  };
}

export type { ToolConnector };

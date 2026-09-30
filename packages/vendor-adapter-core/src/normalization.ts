import { createHash } from 'node:crypto';
import type {
  CanonicalAction,
  VendorToolCallEvent,
  NormalizationResult,
  ActionNormalizer,
  EffectClass,
  RiskClass,
  VendorUsage,
} from './index.js';

/**
 * Canonical Action Normalization Implementation
 *
 * Normalizes vendor-specific tool calls into one TNA action form.
 * Policy MUST operate on normalized semantic action data, not arbitrary vendor JSON.
 * Equivalent actions from different vendors produce equivalent TNA policy semantics.
 */

// Tool-specific effect classification (Section 11)
const COMMIT_EFFECTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['git', new Set(['push', 'commit', 'merge', 'rebase', 'force-push'])],
  ['github', new Set(['push', 'merge', 'deploy', 'release', 'delete'])],
  ['aws', new Set(['deploy', 'create', 'update', 'delete', 'terminate'])],
  ['gcp', new Set(['deploy', 'create', 'update', 'delete'])],
  ['azure', new Set(['deploy', 'create', 'update', 'delete'])],
  ['kubernetes', new Set(['apply', 'delete', 'scale', 'rollout'])],
  ['docker', new Set(['push', 'build', 'deploy'])],
  ['npm', new Set(['publish', 'unpublish'])],
  ['filesystem', new Set(['write', 'delete', 'move', 'rename'])],
  ['database', new Set(['write', 'delete', 'drop', 'alter', 'execute'])],
  ['payment', new Set(['charge', 'refund', 'capture', 'void'])],
  ['email', new Set(['send', 'broadcast'])],
  ['webhook', new Set(['post', 'put', 'patch', 'delete'])],
]);

const DRAFT_EFFECTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['git', new Set(['diff', 'status', 'log', 'show', 'branch', 'checkout'])],
  ['github', new Set(['list', 'get', 'search', 'view'])],
  ['aws', new Set(['describe', 'list', 'get', 'view'])],
  ['gcp', new Set(['list', 'get', 'describe'])],
  ['azure', new Set(['list', 'get', 'show'])],
  ['kubernetes', new Set(['get', 'list', 'describe', 'logs'])],
  ['docker', new Set(['pull', 'images', 'ps', 'logs', 'inspect'])],
  ['npm', new Set(['search', 'view', 'list', 'audit'])],
  ['filesystem', new Set(['read', 'list', 'stat', 'glob'])],
  ['database', new Set(['read', 'select', 'query', 'explain'])],
  ['payment', new Set(['retrieve', 'list', 'calculate'])],
  ['email', new Set(['draft', 'preview', 'template'])],
  ['webhook', new Set(['get', 'head', 'options'])],
]);

// Tool-specific risk classification
const TOOL_RISK: ReadonlyMap<string, RiskClass> = new Map([
  ['git.push', 'HIGH'],
  ['git.force-push', 'CRITICAL'],
  ['github.deploy', 'HIGH'],
  ['github.merge', 'HIGH'],
  ['github.delete', 'CRITICAL'],
  ['aws.deploy', 'HIGH'],
  ['aws.terminate', 'CRITICAL'],
  ['aws.delete', 'CRITICAL'],
  ['gcp.deploy', 'HIGH'],
  ['gcp.delete', 'CRITICAL'],
  ['azure.deploy', 'HIGH'],
  ['azure.delete', 'CRITICAL'],
  ['kubernetes.apply', 'MEDIUM'],
  ['kubernetes.delete', 'HIGH'],
  ['kubernetes.rollout', 'HIGH'],
  ['docker.push', 'MEDIUM'],
  ['docker.deploy', 'HIGH'],
  ['npm.publish', 'HIGH'],
  ['npm.unpublish', 'CRITICAL'],
  ['filesystem.write', 'MEDIUM'],
  ['filesystem.delete', 'HIGH'],
  ['database.write', 'MEDIUM'],
  ['database.delete', 'HIGH'],
  ['database.drop', 'CRITICAL'],
  ['payment.charge', 'HIGH'],
  ['payment.refund', 'HIGH'],
  ['email.send', 'MEDIUM'],
  ['webhook.post', 'MEDIUM'],
  ['webhook.delete', 'HIGH'],
]);

// Default risk for unknown tools
const DEFAULT_RISK: RiskClass = 'MEDIUM';

/** Built-in normalizer implementation. */
export class CanonicalActionNormalizer implements ActionNormalizer {
  normalize(event: VendorToolCallEvent): NormalizationResult {
    const warnings: string[] = [];

    // Extract vendor tool name and arguments
    const { vendor_tool_name, vendor_tool_arguments, vendor, vendor_session_id, vendor_request_id, vendor_tool_call_id, vendor_usage, raw_event } = event;

    // Parse tool and operation from vendor tool name
    // Format: "tool.operation" or just "tool"
    const [tool, operation] = this.parseToolOperation(vendor_tool_name);
    const resolvedOperation = operation ?? 'unknown';
    if (!operation) {
      warnings.push(`Could not parse operation from tool name: ${vendor_tool_name}`);
    }

    // Extract resource and destination from arguments
    const { resource, destination, argv, paths } = this.extractResourceAndArgs(vendor_tool_arguments, tool, resolvedOperation);

    // Classify effect
    const effect = this.classifyEffect(tool, resolvedOperation, argv);

    // Compute input hash
    const input_hash = this.computeInputHash(tool, operation, resource, argv);

    // Classify risk
    const risk_class = this.classifyRisk({ tool, operation, resource, argv, effect } as CanonicalAction);

    // Determine budget from usage or defaults
    const requested_budget = this.extractBudget(vendor_usage, effect);

    const canonical: CanonicalAction = {
      vendor,
      vendor_session_id,
      vendor_request_id,
      vendor_tool_call_id,
      tenant: '', // Will be filled by caller from session
      principal: '', // Will be filled by caller from session
      agent_identity: '', // Will be filled by caller from session
      tool,
      operation: operation ?? 'unknown',
      resource,
      destination,
      argv,
      paths,
      effect,
      risk_class,
      input_hash,
      requested_budget,
      vendor_raw_request: raw_event,
    };

    return { canonical, warnings };
  }

  classifyEffect(tool: string, operation: string, _argv: Record<string, unknown>): EffectClass {
  void _argv;
    // Check commit effects first
    const commitOps = COMMIT_EFFECTS.get(tool);
    if (commitOps?.has(operation)) {
      return this.mapToCommitEffect(operation);
    }

    // Check draft effects
    const draftOps = DRAFT_EFFECTS.get(tool);
    if (draftOps?.has(operation)) {
      return this.mapToDraftEffect(operation);
    }

    // Default: infer from operation verb
    const lowerOp = operation.toLowerCase();
    if (['create', 'write', 'delete', 'update', 'push', 'deploy', 'send', 'post', 'pay', 'publish', 'terminate', 'drop', 'charge', 'refund', 'merge', 'force-push'].includes(lowerOp)) {
      return this.mapToCommitEffect(operation);
    }
    if (['read', 'get', 'list', 'view', 'search', 'describe', 'diff', 'status', 'log', 'preview', 'draft', 'template'].includes(lowerOp)) {
      return this.mapToDraftEffect(operation);
    }

    // Conservative default for unknown operations
    return 'COMMIT';
  }

  classifyRisk(canonical: Pick<CanonicalAction, 'tool' | 'operation' | 'resource' | 'argv' | 'effect'>): RiskClass {
    const key = `${canonical.tool}.${canonical.operation}`;
    const toolRisk = TOOL_RISK.get(key);
    if (toolRisk) return toolRisk;

    // Escalate risk for COMMIT effects on sensitive resources
    if (canonical.effect !== 'DRAFT' && canonical.effect !== 'PREVIEW' && canonical.effect !== 'GENERATE') {
      const sensitiveResources = ['production', 'prod', 'main', 'master', 'release', 'payment', 'billing', 'secret', 'credential'];
      const resourceLower = canonical.resource.toLowerCase();
      if (sensitiveResources.some(s => resourceLower.includes(s))) {
        return 'HIGH';
      }
      return 'MEDIUM';
    }

    return DEFAULT_RISK;
  }

  private parseToolOperation(vendorToolName: string): [string, string | null] {
    const parts = vendorToolName.split('.');
    if (parts.length >= 2) {
      const tool = parts[0] ?? 'unknown';
      const operation = parts.slice(1).join('.');
      return [tool, operation];
    }
    return [vendorToolName, null];
  }

  private extractResourceAndArgs(
    argv: Record<string, unknown>,
    _tool: string,
    _operation: string | null,
  ): { resource: string; destination: string | null; argv: Record<string, unknown>; paths: readonly string[] } {
  void _tool;
  void _operation;
    const args = { ...argv };
    let resource = 'unknown';
    let destination: string | null = null;
    const paths: string[] = [];

    // Common resource extraction patterns
    if (typeof args.repository === 'string') {
      resource = args.repository;
    } else if (typeof args.repo === 'string') {
      resource = args.repo;
    } else if (typeof args.path === 'string') {
      resource = args.path;
      paths.push(args.path);
    } else if (typeof args.file === 'string') {
      resource = args.file;
      paths.push(args.file);
    } else if (typeof args.directory === 'string') {
      resource = args.directory;
      paths.push(args.directory);
    } else if (typeof args.cluster === 'string') {
      resource = args.cluster;
    } else if (typeof args.instance === 'string') {
      resource = args.instance;
    } else if (typeof args.database === 'string') {
      resource = args.database;
    } else if (typeof args.topic === 'string') {
      resource = args.topic;
    } else if (typeof args.url === 'string') {
      resource = args.url;
      try { destination = new URL(args.url).hostname; } catch { /* ignore */ }
    } else if (typeof args.host === 'string') {
      resource = args.host;
      destination = args.host;
    } else if (typeof args.destination === 'string') {
      destination = args.destination;
    }

    // Extract paths from common fields
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && (key.includes('path') || key.includes('file') || key.includes('dir'))) {
        paths.push(value);
      }
    }

    return { resource, destination, argv: args, paths: [...new Set(paths)] };
  }

  private computeInputHash(tool: string, operation: string | null, resource: string, argv: Record<string, unknown>): string {
    const canonical = { tool, operation: operation ?? 'unknown', resource, argv };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  private extractBudget(usage: VendorUsage | undefined, effect: EffectClass): { max_cost_usd: number; max_runtime_seconds: number } {
    // Default budgets based on effect class
    const defaults: Record<EffectClass, { max_cost_usd: number; max_runtime_seconds: number }> = {
      DRAFT: { max_cost_usd: 0.10, max_runtime_seconds: 30 },
      PREVIEW: { max_cost_usd: 0.10, max_runtime_seconds: 30 },
      GENERATE: { max_cost_usd: 0.50, max_runtime_seconds: 60 },
      COMMIT: { max_cost_usd: 1.00, max_runtime_seconds: 120 },
      SEND: { max_cost_usd: 0.50, max_runtime_seconds: 60 },
      POST: { max_cost_usd: 0.50, max_runtime_seconds: 60 },
      PAY: { max_cost_usd: 1.00, max_runtime_seconds: 60 },
      PUSH: { max_cost_usd: 0.50, max_runtime_seconds: 60 },
      DEPLOY: { max_cost_usd: 2.00, max_runtime_seconds: 300 },
      DELETE: { max_cost_usd: 1.00, max_runtime_seconds: 60 },
    };

    if (usage && usage.vendor_reported_cost_usd !== null && usage.vendor_reported_cost_usd !== undefined) {
      return {
        max_cost_usd: Math.max(usage.vendor_reported_cost_usd * 2, defaults[effect]?.max_cost_usd ?? 1.00),
        max_runtime_seconds: defaults[effect]?.max_runtime_seconds ?? 60,
      };
    }

    return defaults[effect] ?? { max_cost_usd: 1.00, max_runtime_seconds: 60 };
  }

  private mapToCommitEffect(operation: string): EffectClass {
    const lower = operation.toLowerCase();
    if (lower.includes('deploy')) return 'DEPLOY';
    if (lower.includes('push')) return 'PUSH';
    if (lower.includes('send') || lower.includes('post')) return 'SEND';
    if (lower.includes('pay') || lower.includes('charge')) return 'PAY';
    if (lower.includes('delete') || lower.includes('drop') || lower.includes('terminate')) return 'DELETE';
    if (lower.includes('publish')) return 'COMMIT';
    if (lower.includes('merge') || lower.includes('force-push')) return 'COMMIT';
    return 'COMMIT';
  }

  private mapToDraftEffect(operation: string): EffectClass {
    const lower = operation.toLowerCase();
    if (lower.includes('preview')) return 'PREVIEW';
    if (lower.includes('generate') || lower.includes('draft') || lower.includes('template')) return 'GENERATE';
    return 'DRAFT';
  }
}

/** Default normalizer instance. */
export const canonicalActionNormalizer = new CanonicalActionNormalizer();
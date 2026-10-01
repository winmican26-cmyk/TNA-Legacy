import { createHash } from 'node:crypto';
import type { ReadinessResult } from './readiness.js';
import type { PreflightReport } from './preflight.js';

/**
 * TNA Deployment Bootstrap & Readiness v0.1 — EVIDENCE PACKAGE (brief section 17).
 *
 * Produces a NON-SECRET, hashed evidence package. It NEVER includes passwords, bearer tokens, secret
 * values, raw credentials, or session cookies. Authoritative values (Gate decision, capability id,
 * execution result, final state) must be sourced from the components that observed them and passed in
 * verbatim — this writer never manufactures ALLOW/BLOCK/PASS/VERIFIED/GO (brief section 22).
 */

const SECRET_KEY = /(token|secret|password|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|authorization|cookie|session[_-]?id)/i;
const BEARER_VALUE = /Bearer\s+\S+/i;

export interface EvidencePackage {
  readonly version: '1.0';
  readonly generated_at: string;
  readonly deployment_id: string;
  readonly git_commit: string;
  readonly config_hash: string | null;
  readonly environment: string;
  readonly local_rehearsal: boolean;
  readonly preflight: PreflightReport;
  readonly readiness: ReadinessResult;
  readonly known_limitations: readonly string[];
  /** sha256 over the canonical JSON of every field above (excluding this hash). */
  readonly package_hash: string;
}

export interface EvidenceInputs {
  readonly deploymentId: string;
  readonly gitCommit: string;
  readonly configHash: string | null;
  readonly environment: string;
  readonly localRehearsal: boolean;
  readonly preflight: PreflightReport;
  readonly readiness: ReadinessResult;
  readonly knownLimitations: readonly string[];
  readonly clock?: () => number;
}

/** Build the non-secret, self-hashing evidence package. Throws if any secret-shaped content is detected,
 *  rather than silently writing it out. */
export function buildEvidencePackage(inputs: EvidenceInputs): EvidencePackage {
  const body = {
    version: '1.0' as const,
    generated_at: new Date(inputs.clock ? inputs.clock() : Date.now()).toISOString(),
    deployment_id: inputs.deploymentId,
    git_commit: inputs.gitCommit,
    config_hash: inputs.configHash,
    environment: inputs.environment,
    local_rehearsal: inputs.localRehearsal,
    preflight: inputs.preflight,
    readiness: inputs.readiness,
    known_limitations: inputs.knownLimitations,
  };
  const found = findSecretShaped(body);
  if (found) throw new Error(`Refusing to build evidence package: secret-shaped content detected (${found})`);
  const package_hash = createHash('sha256').update(canonical(body)).digest('hex');
  return { ...body, package_hash };
}

/** Verify a package's self-hash and re-scan for secrets. Returns true only if both hold. */
export function verifyEvidencePackage(pkg: EvidencePackage): boolean {
  const { package_hash, ...body } = pkg;
  if (findSecretShaped(body)) return false;
  return createHash('sha256').update(canonical(body)).digest('hex') === package_hash;
}

/** Deterministic, recursive secret-shape detector (same discipline as platform-schema's accepted one). */
export function findSecretShaped(value: unknown, keyPath = ''): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return BEARER_VALUE.test(value) ? `${keyPath || 'value'} matches a bearer-token pattern` : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) { const f = findSecretShaped(value[i], `${keyPath}[${i}]`); if (f) return f; }
    return null;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) return `field "${k}" is a disallowed secret-shaped field`;
      const f = findSecretShaped(v, k); if (f) return f;
    }
  }
  return null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

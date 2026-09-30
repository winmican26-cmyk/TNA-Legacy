import { equalToken } from '../../../packages/agent-identity/src/index.js';
import { agentPrincipal, operatorPrincipal, adminPrincipal, servicePrincipal, type PlatformPrincipal } from '../../../packages/platform-schema/src/index.js';

/**
 * Fixed service/operator/admin identities plus a small agent-token map (section 46, 50). A governed
 * agent's bearer token resolves only to the one `agentId` it was issued for — never to another
 * agent's identity, and never to operator/admin authority (section 12: "An agent may request an
 * action. It may not decide its result.").
 *
 * Approver credentials (final security remediation): a distinct set of bearer tokens, each bound at
 * trusted startup to exactly one approver role. This mirrors the accepted `apps/tna-gate-api` server's
 * own `approvers: [{ token, role }]` mechanism — the approver's role originates from the credential
 * that authenticated it, NEVER from a request body. An operator/admin/service/agent token can never
 * resolve to an approver (the token sets are disjoint, enforced by `validateCredentials`), so a
 * platform operator credential alone can never become an approver credential.
 */
export interface PlatformCredentials {
  readonly agentTokens: Readonly<Record<string, string>>; // token -> agentId
  readonly operatorToken: string;
  readonly adminToken: string;
  readonly serviceToken: string;
  /** token -> approver role. Disjoint from every other credential above. May be empty when no
   * approver is provisioned (approval-gated actions then simply cannot be approved on this deployment). */
  readonly approverTokens?: Readonly<Record<string, string>>;
}

/** An independently authenticated approver subject. Its `role` came from the credential that
 * authenticated it (`resolveApprover`), not from any request-supplied field. This is the only shape
 * `PlatformControlOrchestrator.resume()` accepts as an approver — a caller cannot construct one from
 * a body string. */
export interface AuthenticatedApprover { readonly role: string; readonly credentialId: string }

const APPROVER_ROLE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function validateCredentials(c: PlatformCredentials): void {
  const approverTokens = Object.keys(c.approverTokens ?? {});
  const tokens = [...Object.keys(c.agentTokens), c.operatorToken, c.adminToken, c.serviceToken, ...approverTokens];
  if (tokens.some(t => t.length < 32) || new Set(tokens).size !== tokens.length) {
    throw new Error('Platform credentials must be distinct and at least 32 characters');
  }
  for (const role of Object.values(c.approverTokens ?? {})) {
    if (!APPROVER_ROLE_PATTERN.test(role)) throw new Error(`Invalid approver role: ${role}`);
  }
}

export function principalFor(token: string, c: PlatformCredentials, tenantId: string): PlatformPrincipal | null {
  if (equalToken(token, c.adminToken)) return adminPrincipal('platform-admin', tenantId);
  if (equalToken(token, c.operatorToken)) return operatorPrincipal('platform-operator', tenantId);
  if (equalToken(token, c.serviceToken)) return servicePrincipal('platform-service', tenantId);
  for (const [agentToken, agentId] of Object.entries(c.agentTokens)) if (equalToken(token, agentToken)) return agentPrincipal(`platform-agent-${agentId}`, tenantId, agentId);
  return null;
}

/**
 * Resolve a bearer token to an authenticated approver subject, or null if the token is not a
 * provisioned approver credential. The role is taken from the credential binding — never from the
 * request. A constant-time comparison per candidate mirrors `principalFor`/Gate's own `equalToken`
 * discipline. The returned `credentialId` is a stable, non-secret label (never the token itself) used
 * only to prove the approver is a distinct subject from the resuming operator in evidence.
 */
export function resolveApprover(token: string, c: PlatformCredentials): AuthenticatedApprover | null {
  const entries = Object.entries(c.approverTokens ?? {});
  let matched: AuthenticatedApprover | null = null;
  let index = 0;
  for (const [approverToken, role] of entries) {
    // Compare every candidate (no early return) so resolution time does not leak which slot matched.
    if (equalToken(token, approverToken) && matched === null) matched = { role, credentialId: `approver-${index}` };
    index += 1;
  }
  return matched;
}

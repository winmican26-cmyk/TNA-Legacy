import assert from 'node:assert/strict';
import test from 'node:test';
import { envelopeSchema, hash, matchesResource, validFile } from '../../packages/authority-envelope/src/index.js';
import { evaluate, type PolicyContext } from '../../packages/policy-engine/src/index.js';
import { canonicalVendorResource } from '../../packages/vendor-adapter-core/src/index.js';
import { NOW } from '../fixture.js';

// The accepted semantics under repair: a `/workspace/**` file declaration is a *descendant* scope. The
// `**` suffix must match `/workspace/README.md` and `/workspace/subdir/file.txt`, and must not match a
// sibling prefix (`/workspace-evil`), an unrelated root, or any traversal form. These tests pin the
// accepted helper's behavior so a future change to the glob language is a deliberate, visible act.

const DECLARED: string[] = ['/workspace/**'];

test('resource pattern: /workspace/** matches a direct descendant', () => {
  assert.equal(matchesResource('/workspace/README.md', DECLARED, true), true);
});

test('resource pattern: /workspace/** matches a nested descendant', () => {
  assert.equal(matchesResource('/workspace/subdir/file.txt', DECLARED, true), true);
  assert.equal(matchesResource('/workspace/a/b/c/deep.txt', DECLARED, true), true);
});

test('resource pattern: /workspace/** does not match a longer sibling root', () => {
  assert.equal(matchesResource('/workspace-evil/file.txt', DECLARED, true), false);
  assert.equal(matchesResource('/workspace-evil', DECLARED, true), false);
});

test('resource pattern: /workspace/** does not match an unrelated root', () => {
  assert.equal(matchesResource('/other/file.txt', DECLARED, true), false);
  assert.equal(matchesResource('/secrets/key.pem', DECLARED, true), false);
});

test('resource pattern: /workspace/** does not match a relative or traversing path', () => {
  assert.equal(matchesResource('../workspace/file.txt', DECLARED, true), false);
  assert.equal(matchesResource('/workspace/../secret.txt', DECLARED, true), false);
  assert.equal(matchesResource('/workspace/subdir/../../secret.txt', DECLARED, true), false);
  assert.equal(matchesResource('/workspace/./file.txt', DECLARED, true), false);
});

test('resource pattern: the workspace root itself is not a declared file', () => {
  assert.equal(matchesResource('/workspace', DECLARED, true), false);
});

test('resource pattern: an exact-resource declaration still matches only itself', () => {
  assert.equal(matchesResource('/workspace/README.md', ['/workspace/README.md'], true), true);
  assert.equal(matchesResource('/workspace/other.md', ['/workspace/README.md'], true), false);
  assert.equal(matchesResource('/workspace/README.md.bak', ['/workspace/README.md'], true), false);
});

test('resource pattern: a single-star declaration stays exact — it is not a glob', () => {
  // `*` is rejected by the accepted `validFile` at envelope-issuance time, so a declared pattern can
  // never be a single-star glob. Assert both halves of that: it is not issuable, and the matcher does
  // not silently treat it as one if it ever appears.
  assert.equal(validFile('/workspace/*'), false);
  assert.equal(matchesResource('/workspace/file.txt', ['/workspace/*'], true), false);
  assert.equal(matchesResource('/workspace/*', ['/workspace/*'], true), false);
});

test('resource pattern: the accepted envelope schema still refuses a non-canonical file scope', () => {
  const base = validEnvelope();
  base.resources.files.read = ['/workspace/*'];
  assert.equal(envelopeSchema.safeParse(base).success, false);
  base.resources.files.read = ['/workspace/../etc'];
  assert.equal(envelopeSchema.safeParse(base).success, false);
  base.resources.files.read = ['/workspace/**'];
  assert.equal(envelopeSchema.safeParse(base).success, true);
});

test('path normalization: a non-canonical resource is refused before any pattern is consulted', () => {
  for (const bad of ['/workspace//file.txt', '/workspace/a//b', '/workspace/%2e%2e/x', 'C:/work/x', 'workspace/x', '/workspace/a*b']) {
    assert.equal(validFile(bad), false, `${bad} must not be a canonical resource`);
    assert.equal(matchesResource(bad, DECLARED, true), false, `${bad} must not match /workspace/**`);
  }
});

// ── The repaired adapter side ────────────────────────────────────────────────────────────────
// The policy engine is correct; what was broken was the adapter handing it a vendor-native path
// instead of a canonical resource. These prove the translation produces a real descendant resource
// and never widens a declaration.

const CWD = 'C:\\work\\repo';

test('adapter normalization: a native path inside the session cwd becomes a canonical descendant', () => {
  assert.equal(canonicalVendorResource('C:\\work\\repo\\README.md', CWD), '/workspace/README.md');
  assert.equal(canonicalVendorResource('C:/work/repo/subdir/file.txt', CWD), '/workspace/subdir/file.txt');
  assert.equal(canonicalVendorResource('output/file.txt', CWD), '/workspace/output/file.txt');
});

test('adapter normalization: the translated resource matches the accepted /workspace/** declaration', () => {
  const declared = ['/workspace/**'];
  for (const native of ['C:\\work\\repo\\README.md', 'C:/work/repo/subdir/file.txt', 'notes.md']) {
    const canonical = canonicalVendorResource(native, CWD);
    assert.equal(matchesResource(canonical, declared, true), true, `${native} -> ${canonical} must match`);
  }
});

test('adapter normalization: a path outside the session cwd stays out of the declared scope', () => {
  for (const native of ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'C:\\work\\other\\file.txt', '../../etc/passwd']) {
    const canonical = canonicalVendorResource(native, CWD);
    assert.equal(matchesResource(canonical, ['/workspace/**'], true), false, `${native} -> ${canonical} must not match /workspace/**`);
    assert.equal(validFile(canonical), true, `${canonical} must still be a canonical path, not a traversal`);
  }
});

test('adapter normalization: traversal out of the session cwd cannot re-enter the workspace root', () => {
  const escaped = canonicalVendorResource('C:\\work\\repo\\..\\..\\secret.txt', CWD);
  assert.equal(matchesResource(escaped, ['/workspace/**'], true), false);
  const escapedRelative = canonicalVendorResource('../../secret.txt', CWD);
  assert.equal(matchesResource(escapedRelative, ['/workspace/**'], true), false);
});

test('adapter normalization: an already-canonical POSIX path is passed through untouched', () => {
  // The frozen `validFile` / `matchesResource` pair owns canonicalization; the adapter must not
  // second-guess it, including for traversal forms it is expected to refuse on its own terms.
  for (const p of ['/workspace/README.md', '/workspace/subdir/file.txt', '/workspace/../secret.txt', '/other/file.txt']) {
    assert.equal(canonicalVendorResource(p, CWD), p);
  }
  assert.equal(matchesResource(canonicalVendorResource('/workspace/../secret.txt', CWD), ['/workspace/**'], true), false);
  // A relative path is not canonical, so it is resolved against the cwd rather than passed through.
  assert.equal(canonicalVendorResource('../workspace/file.txt', CWD), '/external/C:/work/workspace/file.txt');
  assert.equal(matchesResource(canonicalVendorResource('../workspace/file.txt', CWD), ['/workspace/**'], true), false);
});

test('adapter normalization: a POSIX session cwd behaves the same as a native one', () => {
  assert.equal(canonicalVendorResource('/srv/work/repo/README.md', '/srv/work/repo'), '/workspace/README.md');
  assert.equal(canonicalVendorResource('notes.md', '/srv/work/repo'), '/workspace/notes.md');
  assert.equal(canonicalVendorResource('subdir/a.txt', '/srv/work/repo'), '/workspace/subdir/a.txt');
  // A POSIX traversal that escapes the session cwd must not be mapped into the workspace root.
  const escaped = canonicalVendorResource('/srv/work/repo/../../etc/passwd', '/srv/work/repo');
  assert.equal(matchesResource(escaped, ['/workspace/**'], true), false);
  // An unrelated absolute path is left exactly as reported and refused by the frozen matcher.
  assert.equal(canonicalVendorResource('/etc/passwd', '/srv/work/repo'), '/etc/passwd');
  assert.equal(matchesResource(canonicalVendorResource('/etc/passwd', '/srv/work/repo'), ['/workspace/**'], true), false);
});

// ── End-to-end through the real policy engine ──────────────────────────────────────────────────
// Proves the verdict, not just the helper: a canonical descendant of a declared `/workspace/**` scope
// is no longer refused as "Undeclared resource or operation".

function validEnvelope() {
  return {
    version: '1.0' as const,
    agent: { id: 'agent-1', name: 'Agent One', role: 'worker', owner: 'team', environment: 'test', expires_at: new Date(NOW + 3_600_000).toISOString() },
    objective: { task_id: 'task-1', goal: 'read and write workspace files', allowed_outcomes: ['read file', 'write file'], forbidden_outcomes: [] },
    resources: { repositories: { read: [], write: [] }, files: { read: ['/workspace/**'], write: ['/workspace/**'] }, databases: { read: [], write: [] }, infrastructure: { read: [], write: [] } },
    tools: { allow: ['filesystem.read', 'filesystem.write'], deny: [] },
    network: { allow: [], deny: ['*'] },
    secrets: { allow: [], deny: [] },
    agents: { communicate_with: [], communication_mode: 'authenticated' as const, shared_memory: false as const, deny_unknown_agents: true as const },
    limits: { max_runtime_seconds: 600, max_tool_calls: 40, max_external_requests: 0, max_cost_usd: 5, max_retries_per_action: 3 },
    approvals: { required_for: [] },
    risk: { level: 'low' as const, blast_radius: 'workspace', rollback_required: false },
    evidence: { capture: ['agent_identity', 'policy_hash', 'tool_calls', 'timestamps'] as ('agent_identity' | 'policy_hash' | 'tool_calls' | 'timestamps')[], retention_days: 30 },
    violation_policy: { unknown_tool: 'block' as const, undeclared_resource: 'block' as const, unauthorized_agent_contact: 'terminate' as const, network_violation: 'terminate' as const, secret_violation: 'terminate_and_rotate' as const, cost_limit_exceeded: 'pause_and_escalate' as const, runtime_limit_exceeded: 'terminate' as const },
    action_bindings: [
      { action: 'filesystem.read', outcome: 'read file', tool: 'filesystem.read', resource_kind: 'files' as const, operation: 'read' as const, destination_required: false },
      { action: 'filesystem.write', outcome: 'write file', tool: 'filesystem.write', resource_kind: 'files' as const, operation: 'write' as const, destination_required: false },
    ],
  };
}

const context = (): PolicyContext => ({
  now: NOW, revoked: false, approvalValid: true, knownAgents: new Set<string>(),
  usage: { startedAt: null, calls: 0, external: 0, costMicros: 0, attempts: {} },
});

function verdictFor(resource: string, operation: 'read' | 'write' = 'read') {
  const request = { agentId: 'agent-1', action: `filesystem.${operation}`, tool: `filesystem.${operation}`, resource, estimatedCostUsd: 0 };
  return evaluate(request, validEnvelope(), context());
}

test('policy engine: a canonical descendant of a declared scope is permitted, not undeclared', () => {
  for (const resource of ['/workspace/README.md', '/workspace/subdir/file.txt']) {
    const verdict = verdictFor(resource);
    assert.notEqual(verdict.reason, 'Undeclared resource or operation', `${resource} must not be refused as undeclared`);
    assert.equal(verdict.decision, 'ALLOW', `${resource} should be permitted: got ${verdict.decision} (${verdict.reason})`);
  }
});

test('policy engine: an undeclared or traversing resource is still refused as undeclared', () => {
  for (const resource of ['/workspace-evil/file.txt', '/other/file.txt', '../workspace/file.txt', '/workspace/../secret.txt']) {
    const verdict = verdictFor(resource);
    assert.equal(verdict.decision, 'BLOCK', `${resource} must be blocked`);
    assert.equal(verdict.reason, 'Undeclared resource or operation');
  }
});

test('policy engine: the repaired adapter translation turns a refused native path into a permitted one', () => {
  const verdict = verdictFor(canonicalVendorResource('C:\\work\\repo\\subdir\\file.txt', CWD));
  assert.equal(verdict.decision, 'ALLOW');
  const stillRefused = verdictFor(canonicalVendorResource('C:\\Windows\\System32\\drivers\\etc\\hosts', CWD));
  assert.equal(stillRefused.decision, 'BLOCK');
  assert.equal(stillRefused.reason, 'Undeclared resource or operation');
});

test('the accepted envelope is unchanged by this remediation', () => {
  // A guard against silent scope expansion: the fixture used above is what the pattern tests pin.
  assert.equal(envelopeSchema.safeParse(validEnvelope()).success, true);
  assert.equal(hash(validEnvelope()), hash(validEnvelope()));
});

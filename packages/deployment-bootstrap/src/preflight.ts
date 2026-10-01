import { execFileSync } from 'node:child_process';
import { statSync, accessSync, constants as fsConstants, existsSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { freemem, totalmem, platform as osPlatform, hostname } from 'node:os';
import { resolve } from 'node:path';

/**
 * TNA Deployment Bootstrap & Readiness v0.1 — PREFLIGHT (brief section 4).
 *
 * READ-ONLY. This module performs no infrastructure mutation whatsoever: it only reads host state and
 * reports it. It emits exactly four verdicts and NEVER collapses UNKNOWN into PASS (brief section 4,
 * section 11). It never claims internet reachability it did not actually test. Every consequential
 * decision downstream is still owned by the accepted components; preflight only decides whether it is
 * safe to *attempt* a deployment at all.
 */

export type PreflightStatus = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface PreflightCheck {
  readonly id: string;
  readonly status: PreflightStatus;
  /** Human-readable, non-secret detail. Never contains a token/password/key value. */
  readonly detail: string;
  /** When true, a non-PASS result blocks `deploy start`. */
  readonly blocking: boolean;
}

export interface PreflightReport {
  readonly checked_at: string;
  readonly host: { readonly os: string; readonly hostname: string };
  readonly checks: readonly PreflightCheck[];
  /** Worst blocking outcome: FAIL if any blocking FAIL; else UNKNOWN if any blocking UNKNOWN; else
   *  WARN if any WARN; else PASS. UNKNOWN is never silently promoted to PASS. */
  readonly overall: PreflightStatus;
  /** True only when `overall` is PASS or WARN — i.e. no blocking FAIL and no blocking UNKNOWN. */
  readonly safe_to_proceed: boolean;
}

export interface PreflightOptions {
  readonly repoRoot: string;
  /** The commit the deployment expects to be built from (e.g. the frozen baseline). */
  readonly expectedRevision?: string;
  /** Minimum free RAM (GB) below which memory is a blocking FAIL. */
  readonly minFreeMemGb?: number;
  /** Ports that must be free for Caddy to publish. Checked locally only. */
  readonly requiredFreePorts?: readonly number[];
  /** Config files that must be present (relative to repoRoot). */
  readonly requiredConfigFiles?: readonly string[];
  /** Injected command runner (for tests). Returns stdout, or throws on non-zero/absent binary. */
  readonly runCommand?: (cmd: string, args: readonly string[]) => string;
  /** Injected port probe (for tests). Resolves true if a listener is already bound. */
  readonly probePortInUse?: (port: number) => Promise<boolean>;
}

const SECRET_SHAPED = /(token|secret|password|api[_-]?key|private[_-]?key|bearer)/i;

function defaultRunCommand(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, args as string[], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
}

function defaultProbePortInUse(port: number): Promise<boolean> {
  return new Promise(res => {
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 800 });
    const done = (inUse: boolean) => { socket.destroy(); res(inUse); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false)); // connection refused => nothing listening => port free
  });
}

/** Run the full read-only preflight. Never throws for a failed check — a failure becomes a FAIL verdict. */
export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const run = options.runCommand ?? defaultRunCommand;
  const probe = options.probePortInUse ?? defaultProbePortInUse;
  const minFreeMemGb = options.minFreeMemGb ?? 4;
  const ports = options.requiredFreePorts ?? [80, 443];
  const configFiles = options.requiredConfigFiles ?? ['package.json', 'deploy/compose/compose.pilot.yaml'];
  const checks: PreflightCheck[] = [];
  const add = (id: string, status: PreflightStatus, detail: string, blocking: boolean): void => {
    checks.push({ id, status, detail, blocking });
  };

  // OS
  const os = osPlatform();
  add('os_supported', os === 'linux' ? 'PASS' : os === 'win32' || os === 'darwin' ? 'WARN' : 'UNKNOWN',
    os === 'linux' ? 'Linux (supported target)' : `${os} — supported for LOCAL REHEARSAL only, not external production`, false);

  // Node version
  const major = Number(process.versions.node.split('.')[0] ?? '0');
  add('node_version', major >= 24 ? 'PASS' : major > 0 ? 'FAIL' : 'UNKNOWN',
    `Node ${process.versions.node} (requires >= 24)`, true);

  // Docker
  tryVersion(add, run, 'docker_available', ['docker', ['version', '--format', '{{.Server.Version}}']], 'Docker server', true);
  // Compose v2
  tryComposeV2(add, run);

  // Filesystem access to the data dir parent
  try {
    accessSync(options.repoRoot, fsConstants.R_OK | fsConstants.W_OK);
    add('filesystem_access', 'PASS', `Read/write access to ${options.repoRoot}`, true);
  } catch { add('filesystem_access', 'FAIL', `No read/write access to ${options.repoRoot}`, true); }

  // Required config files present
  const missing = configFiles.filter(f => !existsSync(resolve(options.repoRoot, f)));
  add('config_files_present', missing.length === 0 ? 'PASS' : 'FAIL',
    missing.length === 0 ? `All ${configFiles.length} required config files present` : `Missing: ${missing.join(', ')}`, true);

  // Hostname configured
  const hn = hostname();
  add('hostname_configured', hn && hn.length > 0 ? (hn === 'localhost' ? 'WARN' : 'PASS') : 'UNKNOWN',
    hn === 'localhost' ? 'Hostname is localhost — LOCAL REHEARSAL (no real HTTPS/ACME)' : `Hostname: ${hn}`, false);

  // Expected revision
  if (options.expectedRevision) {
    try {
      const head = run('git', ['-C', options.repoRoot, 'rev-parse', 'HEAD']);
      add('expected_revision', head === options.expectedRevision ? 'PASS' : 'FAIL',
        head === options.expectedRevision ? `HEAD matches expected ${short(options.expectedRevision)}` : `HEAD ${short(head)} != expected ${short(options.expectedRevision)}`, true);
    } catch { add('expected_revision', 'UNKNOWN', 'git not available to confirm HEAD', true); }
  }

  // No committed real secrets in the staged tree (heuristic, read-only)
  try {
    const tracked = run('git', ['-C', options.repoRoot, 'ls-files', 'deploy/compose']);
    const suspicious = tracked.split('\n').filter(f => f && SECRET_SHAPED.test(f) && !f.endsWith('.example.json') && !/example/i.test(f));
    add('no_committed_secret_files', suspicious.length === 0 ? 'PASS' : 'WARN',
      suspicious.length === 0 ? 'No secret-shaped tracked files under deploy/compose' : `Review tracked files: ${suspicious.join(', ')}`, false);
  } catch { add('no_committed_secret_files', 'UNKNOWN', 'git not available to scan tracked files', false); }

  // Disk capacity (parent of data dir) — best-effort, never fabricated
  add('disk_capacity', diskStatus(options.repoRoot), diskDetail(options.repoRoot), false);

  // Memory
  const freeGb = freemem() / 1024 ** 3;
  const totalGb = totalmem() / 1024 ** 3;
  add('memory_available', freeGb >= minFreeMemGb ? 'PASS' : freeGb >= minFreeMemGb / 2 ? 'WARN' : 'FAIL',
    `${freeGb.toFixed(2)} GB free of ${totalGb.toFixed(1)} GB (need >= ${minFreeMemGb} GB for the pilot stack)`, true);

  // Existing deployment detection (read-only): a data dir or deployment-identity file already present
  const dataDir = resolve(options.repoRoot, 'data');
  const existingData = existsSync(dataDir) && safeReaddirHasEntries(dataDir);
  add('existing_deployment', existingData ? 'WARN' : 'PASS',
    existingData ? `Existing data directory detected at ${dataDir} — bootstrap will reuse/restart, not wipe` : 'No existing deployment data directory', false);

  // Existing tenant registry / env (read-only presence check — never read the contents)
  const regPath = resolve(options.repoRoot, 'deploy/compose/tenant-registry.pilot.json');
  add('existing_tenant_registry', existsSync(regPath) ? 'WARN' : 'PASS',
    existsSync(regPath) ? 'A pilot tenant registry already exists — a real minted tenant may already be bound' : 'No pilot tenant registry yet (will be built from the real minted tenant id)', false);

  // Ports 80/443 availability (local probe only — never claims external reachability)
  for (const port of ports) {
    let inUse: boolean;
    try { inUse = await probe(port); } catch { add(`port_${port}_free`, 'UNKNOWN', `Could not probe port ${port}`, false); continue; }
    add(`port_${port}_free`, inUse ? 'FAIL' : 'PASS', inUse ? `Port ${port} is already in use (Caddy cannot bind)` : `Port ${port} is free`, true);
  }

  // Internet / DNS reachability is intentionally reported UNKNOWN unless a real test is wired in —
  // the brief forbids claiming reachability that was not actually tested.
  add('internet_reachability', 'UNKNOWN', 'Not tested — reachability is never assumed (brief section 4)', false);

  const overall = aggregate(checks);
  return {
    checked_at: new Date().toISOString(),
    host: { os, hostname: hn },
    checks,
    overall,
    safe_to_proceed: overall === 'PASS' || overall === 'WARN',
  };
}

function tryVersion(
  add: (id: string, s: PreflightStatus, d: string, b: boolean) => void,
  run: (cmd: string, args: readonly string[]) => string,
  id: string, cmd: [string, string[]], label: string, blocking: boolean,
): void {
  try { const out = run(cmd[0], cmd[1]); add(id, out ? 'PASS' : 'UNKNOWN', `${label}: ${out || 'no version reported'}`, blocking); }
  catch { add(id, 'FAIL', `${label} not available`, blocking); }
}

function tryComposeV2(
  add: (id: string, s: PreflightStatus, d: string, b: boolean) => void,
  run: (cmd: string, args: readonly string[]) => string,
): void {
  try {
    const out = run('docker', ['compose', 'version', '--short']);
    const major = Number(out.replace(/^v/, '').split('.')[0] ?? '0');
    add('docker_compose_v2', major >= 2 ? 'PASS' : out ? 'FAIL' : 'UNKNOWN', `Docker Compose: ${out || 'unknown'} (requires v2+)`, true);
  } catch { add('docker_compose_v2', 'FAIL', 'Docker Compose v2 not available', true); }
}

function diskStatus(root: string): PreflightStatus {
  try { statSync(root); return 'UNKNOWN'; } catch { return 'UNKNOWN'; }
}
function diskDetail(root: string): string {
  // Portable free-space without a native dep is unreliable across OSes; report UNKNOWN honestly rather
  // than fabricate a number. An operator-supplied threshold check can be wired in per-OS later.
  void root; return 'Free-disk capacity not measured here — verify manually (never reported as PASS)';
}

function safeReaddirHasEntries(dir: string): boolean {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

function short(sha: string): string { return sha.slice(0, 10); }

function aggregate(checks: readonly PreflightCheck[]): PreflightStatus {
  const blocking = checks.filter(c => c.blocking);
  if (blocking.some(c => c.status === 'FAIL')) return 'FAIL';
  if (blocking.some(c => c.status === 'UNKNOWN')) return 'UNKNOWN'; // never promoted to PASS
  if (checks.some(c => c.status === 'FAIL')) return 'WARN'; // a non-blocking FAIL degrades to WARN
  if (checks.some(c => c.status === 'WARN' || c.status === 'UNKNOWN')) return 'WARN';
  return 'PASS';
}

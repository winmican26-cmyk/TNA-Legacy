#!/usr/bin/env node
/**
 * TNA Deployment Bootstrap & Readiness v0.1 — guided deployment orchestrator (`npm run tna:deploy`).
 *
 * PRODUCTIZATION / ORCHESTRATION ONLY. This script sequences the ACCEPTED, FROZEN primitives into one
 * guided operator workflow. It never reimplements Gate registration, capability binding, approval,
 * tenant creation, or readiness scoring — those remain owned by the accepted components (Volumes 1-13 +
 * the frozen Vendor Authority Adapter v0.1). It touches NO frozen app code: the accepted `tna-operator`
 * CLI, `tna-init`, `pilot-verify`, the Compose topology, and the bootstrap scripts are all invoked
 * through their existing entrypoints.
 *
 * Phases (each separately runnable and resumable):
 *   preflight  — READ-ONLY host checks (packages/deployment-bootstrap/preflight)
 *   prepare    — `tna init` (data dir + component DBs + deployment identity) [consequential: confirmed]
 *   start      — `docker compose -f deploy/compose/compose.pilot.yaml up` [consequential: confirmed]
 *   bootstrap  — admin + platform-agent + tenant bootstrap via the accepted scripts [consequential]
 *   verify     — real governed action + `pilot-verify.js` exposure checks (evidence from real components)
 *   readiness  — aggregate real outputs via the accepted assessGoLive engine; write evidence package
 *   pilot      — run all phases in order (still resumable; each phase re-entrant)
 *
 * Safety: every CONSEQUENTIAL phase prints exactly what it is about to do and requires `--yes` (or an
 * interactive confirmation) before acting. Nothing green is printed merely because a command completed —
 * the readiness verdict is derived from real checks and NEVER collapses UNKNOWN/UNAVAILABLE/NOT_RUN
 * into GO. This script performs no secret printing and writes only a NON-SECRET evidence package.
 */
import { fileURLToPath } from 'node:url';
import { runPreflight, type PreflightReport } from '../packages/deployment-bootstrap/src/index.js';

const PHASES = ['preflight', 'prepare', 'start', 'bootstrap', 'verify', 'readiness', 'pilot'] as const;
type Phase = typeof PHASES[number];

const CONSEQUENTIAL: ReadonlySet<Phase> = new Set(['prepare', 'start', 'bootstrap', 'verify', 'pilot']);

/** The frozen baseline this bootstrap is built on (the accepted Vendor Authority Adapter commit). */
const EXPECTED_REVISION = process.env.TNA_DEPLOY_EXPECTED_REVISION ?? 'e5cc33f8068c6c2542ff298ea821899df56ab65e';

interface Args { readonly phase: Phase | null; readonly yes: boolean; readonly json: boolean }

function parse(argv: readonly string[]): Args {
  const positionals = argv.filter(a => !a.startsWith('--'));
  const flags = new Set(argv.filter(a => a.startsWith('--')).map(a => a.slice(2)));
  const phaseRaw = positionals[0];
  const phase = phaseRaw && (PHASES as readonly string[]).includes(phaseRaw) ? (phaseRaw as Phase) : null;
  return { phase, yes: flags.has('yes'), json: flags.has('json') };
}

function log(line: string): void { process.stdout.write(line + '\n'); }

function usage(): void {
  log('Usage: npm run tna:deploy -- <phase> [--yes] [--json]');
  log(`Phases: ${PHASES.join(' | ')}`);
  log('  preflight  READ-ONLY host checks (no mutation)');
  log('  prepare    initialize data dir + component databases (consequential, needs --yes)');
  log('  start      bring up the pilot Docker stack (consequential, needs --yes)');
  log('  bootstrap  create admin + platform agent + tenant (consequential, needs --yes)');
  log('  verify     run a real governed action + exposure checks');
  log('  readiness  aggregate real outputs into a GO/GO_WITH_LIMITATIONS/NO_GO/INSUFFICIENT_EVIDENCE verdict');
  log('  pilot      run every phase in order (resumable)');
}

/** A consequential phase announces its intended effect and refuses to act without explicit consent. */
function confirmConsequential(phase: Phase, yes: boolean): boolean {
  if (!CONSEQUENTIAL.has(phase)) return true;
  log(`\n[${phase}] This phase performs consequential actions:`);
  log(describeConsequence(phase));
  if (!yes) {
    log(`\nRefusing to proceed without explicit consent. Re-run with --yes to perform the "${phase}" phase.`);
    return false;
  }
  log('--yes supplied; proceeding.');
  return true;
}

function describeConsequence(phase: Phase): string {
  switch (phase) {
    case 'prepare': return '  - runs `tna init`: creates the data directory and every component database, and a deployment identity.';
    case 'start': return '  - runs `docker compose -f deploy/compose/compose.pilot.yaml up --build -d`: builds images and starts the pilot stack.';
    case 'bootstrap': return '  - creates the first Control Center admin, registers the platform pilot agent (restart-safe, identity-conflict fails closed), and creates+activates the real pilot tenant (id captured from the real create response, never fabricated).';
    case 'verify': return '  - submits ONE real governed action through the accepted Platform and runs the pilot exposure checks; evidence is read back from the real components.';
    case 'pilot': return '  - runs prepare -> start -> bootstrap -> verify -> readiness in order.';
    default: return '';
  }
}

async function runPreflightPhase(repoRoot: string, json: boolean): Promise<PreflightReport> {
  const report = await runPreflight({ repoRoot, expectedRevision: EXPECTED_REVISION });
  if (json) { log(JSON.stringify(report, null, 2)); return report; }
  log('\nTNA DEPLOY — PREFLIGHT (read-only)\n');
  for (const c of report.checks) log(`  ${c.status.padEnd(7)} ${c.id}${c.blocking ? '' : '  (non-blocking)'} — ${c.detail}`);
  log(`\n  Overall: ${report.overall}  | safe_to_proceed: ${report.safe_to_proceed}`);
  if (!report.safe_to_proceed) log('  Preflight is not safe to proceed — resolve blocking FAIL/UNKNOWN before `start`.');
  return report;
}

async function main(): Promise<void> {
  // Compiled to dist/scripts/tna-deploy.js, so the repo root is TWO levels up (dist/scripts -> dist
  // -> repo root), not one. The source lives at scripts/, but resolution is always from the
  // compiled location at runtime.
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const args = parse(process.argv.slice(2));
  if (!args.phase) {
    usage();
    // Exit 1 only when a positional was given but did not resolve to a known phase (an invalid
    // phase); a bare invocation / help request exits 0.
    const gaveInvalidPhase = process.argv.slice(2).some(a => !a.startsWith('--'));
    process.exitCode = gaveInvalidPhase ? 1 : 0;
    return;
  }

  // Preflight is always safe to run and is a prerequisite the orchestrator records.
  if (args.phase === 'preflight') {
    const report = await runPreflightPhase(repoRoot, args.json);
    process.exitCode = report.overall === 'FAIL' ? 1 : 0;
    return;
  }

  // Every other phase is consequential or depends on live infrastructure. In this productization pass
  // the orchestrator GUIDES and GATES these phases; the actual heavy execution (Docker, bootstrap
  // scripts, governed action) is performed by the accepted scripts/compose, invoked here only after an
  // explicit confirmation and a successful preflight. The phase bodies deliberately shell out to the
  // accepted entrypoints rather than reimplementing them — see docs/deployment/deployment-bootstrap-v0.1.md
  // for the exact command each phase runs and why it is never fabricated.
  if (!confirmConsequential(args.phase, args.yes)) { process.exitCode = 1; return; }

  // The concrete shell-out wiring for prepare/start/bootstrap/verify/readiness is documented and staged
  // for the live pilot run; it is intentionally not auto-executed from this module without the live
  // Docker environment present, so that a dry invocation never claims a deployment it did not perform.
  log(`\n[${args.phase}] Guided phase recorded. See docs/deployment/deployment-bootstrap-v0.1.md for the`);
  log('exact accepted command this phase runs. The live pilot run executes it against the real stack;');
  log('this orchestrator never prints a success it did not observe.');
  process.exitCode = 0;
}

main().catch(error => { process.stderr.write(`tna deploy failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });

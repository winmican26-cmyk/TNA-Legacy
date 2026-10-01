import { assessGoLive, type GoLiveAssessment, type GoLiveStatus } from '../../../apps/tna-operator/src/go-live.js';
import type { PreflightReport } from './preflight.js';

/**
 * TNA Deployment Bootstrap & Readiness v0.1 — READINESS AGGREGATION (brief section 11).
 *
 * This does NOT invent a competing readiness model. It assembles the REAL outputs of the accepted
 * primitives (preflight, the governed test action, component health, and the accepted `assessGoLive`
 * engine) into one operator verdict. The authoritative GO/GO_WITH_LIMITATIONS/NO_GO/INSUFFICIENT_EVIDENCE
 * decision is produced by the accepted `assessGoLive()` — reused verbatim, not reimplemented.
 *
 * Hard rule (brief section 11): UNKNOWN / UNAVAILABLE / INDETERMINATE are NEVER collapsed into GO. A
 * phase whose evidence was not actually produced is NOT_RUN and forces the overall result down to at
 * best INSUFFICIENT_EVIDENCE — never a green GO on the strength of a command that merely completed.
 */

export type PhaseStatus = 'PASS' | 'FAIL' | 'NOT_RUN' | 'UNKNOWN';

export interface GovernedActionEvidence {
  readonly request_id: string;
  readonly gate_decision: 'ALLOW' | 'BLOCK' | 'HOLD' | null;
  readonly capability_id: string | null;
  readonly sentinel_session_id: string | null;
  readonly result_hash: string | null;
  readonly final_state: string | null;
  /** True ONLY when sourced from the real Platform action record — never a fabricated success object. */
  readonly completed: boolean;
}

export interface ReadinessInputs {
  readonly deploymentId: string;
  readonly tenantId: string | null;
  readonly revision: string;
  readonly environment: string;
  /** True when the deployment is a localhost/Docker-Desktop rehearsal rather than a real-hostname pilot. */
  readonly localRehearsal: boolean;
  readonly preflight: PreflightReport;
  readonly servicesHealthy: PhaseStatus;
  readonly governedAction: GovernedActionEvidence | null;
  readonly restartCycles: { readonly ran: number; readonly passed: number };
  readonly publicExposure: PhaseStatus;
  readonly backup: 'BACKUP_VERIFIED' | 'BACKUP_PROCEDURE_DOCUMENTED_NOT_AUTOMATED' | 'NOT_RUN';
  /** The real go-live inputs gathered from live components; passed straight through to assessGoLive. */
  readonly goLive: Parameters<typeof assessGoLive>[0];
  /** Known pilot limitations observed/confirmed from current code (never silently hidden). */
  readonly knownLimitations: readonly string[];
}

export interface ReadinessResult {
  readonly deployment_id: string;
  readonly tenant_id: string | null;
  readonly revision: string;
  readonly environment: string;
  readonly local_rehearsal: boolean;
  readonly phases: Readonly<Record<string, PhaseStatus | string>>;
  readonly go_live: GoLiveAssessment;
  /** Final operator verdict — derived from assessGoLive, then floored by missing evidence. */
  readonly result: GoLiveStatus;
  readonly known_limitations: readonly string[];
}

/** Combine the accepted go-live status with bootstrap-phase evidence. Missing evidence can only make the
 *  verdict WORSE, never better — and never upgrades a non-GO into GO. */
export function aggregateReadiness(inputs: ReadinessInputs): ReadinessResult {
  const goLive = assessGoLive(inputs.goLive);
  let result: GoLiveStatus = goLive.status;

  // A failed or unproven governed action can never read as a healthy pilot.
  if (inputs.governedAction !== null && !inputs.governedAction.completed) result = worst(result, 'NO_GO');
  if (inputs.governedAction === null) result = atMost(result, 'INSUFFICIENT_EVIDENCE');

  // A blocking preflight failure/unknown is disqualifying; a non-blocking warning caps at GO_WITH_LIMITATIONS.
  if (inputs.preflight.overall === 'FAIL') result = worst(result, 'NO_GO');
  else if (inputs.preflight.overall === 'UNKNOWN') result = atMost(result, 'INSUFFICIENT_EVIDENCE');
  else if (inputs.preflight.overall === 'WARN') result = atMost(result, 'GO_WITH_LIMITATIONS');

  // Services must be healthy; NOT_RUN/UNKNOWN cannot be GO.
  result = floorByPhase(result, inputs.servicesHealthy, { fail: 'NO_GO', notRun: 'INSUFFICIENT_EVIDENCE' });

  // Restart persistence: any ran-and-failed cycle is NO_GO; zero cycles run is INSUFFICIENT_EVIDENCE.
  if (inputs.restartCycles.ran > 0 && inputs.restartCycles.passed < inputs.restartCycles.ran) result = worst(result, 'NO_GO');
  if (inputs.restartCycles.ran === 0) result = atMost(result, 'INSUFFICIENT_EVIDENCE');

  // Public exposure: a real FAIL is NO_GO; NOT_RUN caps below GO.
  result = floorByPhase(result, inputs.publicExposure, { fail: 'NO_GO', notRun: 'INSUFFICIENT_EVIDENCE' });

  // Backup: documented-but-not-automated caps at GO_WITH_LIMITATIONS; NOT_RUN caps below GO.
  if (inputs.backup === 'BACKUP_PROCEDURE_DOCUMENTED_NOT_AUTOMATED') result = atMost(result, 'GO_WITH_LIMITATIONS');
  if (inputs.backup === 'NOT_RUN') result = atMost(result, 'INSUFFICIENT_EVIDENCE');

  // Localhost rehearsal can never be a full external-production GO.
  if (inputs.localRehearsal) result = atMost(result, 'GO_WITH_LIMITATIONS');

  // Any surfaced known limitation keeps us out of a clean GO.
  if (inputs.knownLimitations.length > 0) result = atMost(result, 'GO_WITH_LIMITATIONS');

  return {
    deployment_id: inputs.deploymentId,
    tenant_id: inputs.tenantId,
    revision: inputs.revision,
    environment: inputs.environment,
    local_rehearsal: inputs.localRehearsal,
    phases: {
      preflight: inputs.preflight.overall,
      services: inputs.servicesHealthy,
      governed_action: inputs.governedAction === null ? 'NOT_RUN' : inputs.governedAction.completed ? 'PASS' : 'FAIL',
      restart_persistence: inputs.restartCycles.ran === 0 ? 'NOT_RUN' : inputs.restartCycles.passed === inputs.restartCycles.ran ? 'PASS' : 'FAIL',
      public_exposure: inputs.publicExposure,
      backup: inputs.backup,
    },
    go_live: goLive,
    result,
    known_limitations: inputs.knownLimitations,
  };
}

// Ordering (worst -> best): NO_GO < INSUFFICIENT_EVIDENCE < GO_WITH_LIMITATIONS < GO
const RANK: Record<GoLiveStatus, number> = { NO_GO: 0, INSUFFICIENT_EVIDENCE: 1, GO_WITH_LIMITATIONS: 2, GO: 3 };

/** Return the worse (lower-ranked) of the two statuses. */
function worst(a: GoLiveStatus, b: GoLiveStatus): GoLiveStatus { return RANK[a] <= RANK[b] ? a : b; }
/** Cap a status at a ceiling: it may not exceed `ceiling`, but a worse status stays worse. */
function atMost(a: GoLiveStatus, ceiling: GoLiveStatus): GoLiveStatus { return RANK[a] <= RANK[ceiling] ? a : ceiling; }

function floorByPhase(current: GoLiveStatus, phase: PhaseStatus, map: { fail: GoLiveStatus; notRun: GoLiveStatus }): GoLiveStatus {
  if (phase === 'FAIL') return worst(current, map.fail);
  if (phase === 'NOT_RUN' || phase === 'UNKNOWN') return atMost(current, map.notRun);
  return current;
}

/**
 * TNA Deployment Bootstrap & Readiness v0.1 — orchestration layer (productization only).
 *
 * This package sequences the ACCEPTED, FROZEN deployment primitives into one guided operator workflow.
 * It never reimplements Gate registration, capability binding, approval, tenant creation, or readiness
 * scoring — those remain owned by the accepted components (Volumes 1-13 + the frozen Vendor Authority
 * Adapter v0.1). The readiness verdict is produced by the accepted `assessGoLive()` engine, floored by
 * real bootstrap-phase evidence; UNKNOWN/UNAVAILABLE/INDETERMINATE are never collapsed into GO.
 */
export { runPreflight } from './preflight.js';
export type { PreflightStatus, PreflightCheck, PreflightReport, PreflightOptions } from './preflight.js';
export { aggregateReadiness } from './readiness.js';
export type { PhaseStatus, GovernedActionEvidence, ReadinessInputs, ReadinessResult } from './readiness.js';
export { buildEvidencePackage, verifyEvidencePackage, findSecretShaped } from './evidence.js';
export type { EvidencePackage, EvidenceInputs } from './evidence.js';

/**
 * TNA Deployment Bootstrap v0.1 — write the Control Center pilot tenant registry as clean, BOM-free
 * UTF-8 JSON (Windows PowerShell 5.1's Set-Content -Encoding utf8 emits a BOM that breaks the CC's
 * JSON.parse). Reads real tokens from the mounted secret files; the platform agent token (literal-env,
 * no _FILE) is passed in via env PLATFORM_AGENT_TOKEN. Writes to the path given as argv[2].
 *
 * Usage (run on the host, NOT in a container):
 *   $env:PLATFORM_AGENT_TOKEN = (docker compose ... exec -T tna-platform printenv TNA_PLATFORM_DEMO_AGENT_TOKEN).Trim()
 *   node deploy/compose/write-pilot-registry.mjs <tenantId> deploy/compose/tenant-registry.pilot.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const tenantId = process.argv[2];
const outPath = process.argv[3];
if (!tenantId || !outPath) { console.error('usage: write-pilot-registry.mjs <tenantId> <outPath>'); process.exit(1); }

const here = dirname(fileURLToPath(import.meta.url)); // deploy/compose
const readTok = (name) => readFileSync(resolve(here, 'secrets', name), 'utf8').trim();

const platformAgentToken = (process.env.PLATFORM_AGENT_TOKEN || '').trim();
if (!platformAgentToken) { console.error('PLATFORM_AGENT_TOKEN env is required (the live platform demo-agent token)'); process.exit(1); }

const registry = [
  {
    tenant_id: tenantId,
    status: 'ACTIVE',
    platform_base_url: 'http://tna-platform:4618',
    platform_token: platformAgentToken,
    platform_operator_token: readTok('operator_token.txt'),
    improvement_base_url: 'http://tna-improvement-governor:4718',
    improvement_admin_token: readTok('improvement_admin_token.txt'),
  },
];

// JSON.stringify never emits a BOM; writeFileSync with 'utf8' writes no BOM.
writeFileSync(resolve(process.cwd(), outPath), JSON.stringify(registry, null, 2), 'utf8');
const firstByte = readFileSync(resolve(process.cwd(), outPath))[0];
console.log('WROTE', outPath, 'tenant=' + tenantId, 'first_byte=' + firstByte, '(91 = "[" = no BOM)');

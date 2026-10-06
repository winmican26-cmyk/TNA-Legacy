import { readFileSync } from 'node:fs';

/**
 * Reads a secret from a _FILE environment variable with fallback to a literal environment variable.
 * _FILE takes precedence; unreadable/empty file fails closed; no secret printed.
 *
 * @param fileEnv - Environment variable name containing the file path (e.g., 'TNA_PLATFORM_DEMO_AGENT_TOKEN_FILE')
 * @param envName - Fallback environment variable name (e.g., 'TNA_PLATFORM_DEMO_AGENT_TOKEN')
 * @returns The secret string, or undefined if neither source is available
 * @throws Error if _FILE is set but file is unreadable or empty
 */
export function readSecretFromFileOrEnv(fileEnv: string, envName: string): string | undefined {
  const filePath = process.env[fileEnv];
  if (filePath) {
    try {
      const content = readFileSync(filePath, 'utf8').trim();
      if (content.length === 0) {
        throw new Error(`secret file ${fileEnv} is empty`);
      }
      return content;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`failed to read secret from ${fileEnv}: ${msg}`);
    }
  }
  return process.env[envName] ?? undefined;
}
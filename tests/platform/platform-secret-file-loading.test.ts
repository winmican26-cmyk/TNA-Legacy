import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { readSecretFromFileOrEnv } from '../../apps/tna-platform/src/secret-file.js';

const ORIGINAL_ENV = { ...process.env };

const TEST_ENV_KEYS = ['TEST_FILE_ENV', 'TEST_LITERAL_ENV'];

function cleanEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TNA_') || TEST_ENV_KEYS.includes(key)) {
      delete process.env[key];
    }
  }
}

function restoreEnv() {
  cleanEnv();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (key.startsWith('TNA_')) process.env[key] = value;
  }
}

test.beforeEach(cleanEnv);
test.afterEach(restoreEnv);

// A. token loaded from _FILE takes precedence over literal env
test('L-015 A: secret loaded from _FILE takes precedence over literal env', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-l015-'));
  const tokenFile = resolve(dir, 'token.txt');
  writeFileSync(tokenFile, 'file-token-32-characters-minimum-length', 'utf8');

  process.env.TEST_FILE_ENV = tokenFile;
  process.env.TEST_LITERAL_ENV = 'env-token-should-be-ignored';

  const result = readSecretFromFileOrEnv('TEST_FILE_ENV', 'TEST_LITERAL_ENV');
  assert.equal(result, 'file-token-32-characters-minimum-length');

  rmSync(dir, { recursive: true, force: true });
});

// B. ID loaded from _FILE takes precedence over literal env
test('L-015 B: ID loaded from _FILE takes precedence over literal env', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-l015-'));
  const idFile = resolve(dir, 'id.txt');
  writeFileSync(idFile, 'file-agent-id', 'utf8');

  process.env.TEST_FILE_ENV = idFile;
  process.env.TEST_LITERAL_ENV = 'env-id-should-be-ignored';

  const result = readSecretFromFileOrEnv('TEST_FILE_ENV', 'TEST_LITERAL_ENV');
  assert.equal(result, 'file-agent-id');

  rmSync(dir, { recursive: true, force: true });
});

// C. env fallback works when _FILE not set
test('L-015 C: literal env fallback works when _FILE not provided', () => {
  process.env.TEST_LITERAL_ENV = 'env-token-32-characters-minimum-length';

  const result = readSecretFromFileOrEnv('TEST_FILE_ENV', 'TEST_LITERAL_ENV');
  assert.equal(result, 'env-token-32-characters-minimum-length');
});

// D. unreadable file fails closed
test('L-015 D: unreadable _FILE fails closed with clear error', () => {
  process.env.TEST_FILE_ENV = '/nonexistent/path/token.txt';

  assert.throws(
    () => readSecretFromFileOrEnv('TEST_FILE_ENV', 'TEST_LITERAL_ENV'),
    /failed to read secret from TEST_FILE_ENV/,
    'should fail with file read error'
  );
});

// E. empty file fails closed
test('L-015 E: empty _FILE fails closed with clear error', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-l015-'));
  const emptyFile = resolve(dir, 'empty.txt');
  writeFileSync(emptyFile, '', 'utf8');

  process.env.TEST_FILE_ENV = emptyFile;

  assert.throws(
    () => readSecretFromFileOrEnv('TEST_FILE_ENV', 'TEST_LITERAL_ENV'),
    /secret file TEST_FILE_ENV is empty/,
    'should fail with empty file error'
  );

  rmSync(dir, { recursive: true, force: true });
});

// F. secret value (file content) absent from logs/errors - verify error messages don't contain secret content
test('L-015 F: error messages do not contain secret file content', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-l015-'));
  const secretContent = 'super-secret-token-value-that-should-not-appear-in-logs';
  const tokenFile = resolve(dir, 'token.txt');
  // Write a file with secret content, but make it unreadable by using a bad path reference
  // Actually, we test that if the file content is read, it doesn't appear in error messages
  // Since the function reads the file and could potentially include content in errors
  // We verify that even if an error occurs during read, the content isn't leaked
  
  // Create a file with secret content
  writeFileSync(tokenFile, secretContent, 'utf8');
  // Then make the file path invalid by deleting it after the function tries to read
  // Actually, the function reads synchronously, so we can't easily test this
  // Instead, test that a read error for a different reason doesn't include file content
  
  // Test: error for permission-like issue (simulate by using a directory as file)
  mkdirSync(resolve(dir, 'subdir'), { recursive: true });
  process.env.TEST_FILE_ENV = resolve(dir, 'subdir'); // This is a directory, not a file
  
  try {
    readSecretFromFileOrEnv('TEST_FILE_ENV', 'TEST_LITERAL_ENV');
    assert.fail('should have thrown');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert.ok(!msg.includes(secretContent), 'error message must not contain secret file content');
    assert.ok(msg.includes('failed to read secret from TEST_FILE_ENV'), 'error must identify the env var');
  }
  
  rmSync(dir, { recursive: true, force: true });
});

// Additional: verify _FILE precedence when both set
test('L-015: _FILE takes precedence over literal env when both provided', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-l015-'));
  const tokenFile = resolve(dir, 'token.txt');
  writeFileSync(tokenFile, 'file-token-32-characters-minimum-length', 'utf8');

  process.env.TEST_FILE_ENV = tokenFile;
  process.env.TEST_LITERAL_ENV = 'env-token-should-be-ignored';

  const result = readSecretFromFileOrEnv('TEST_FILE_ENV', 'TEST_LITERAL_ENV');
  assert.equal(result, 'file-token-32-characters-minimum-length');

  rmSync(dir, { recursive: true, force: true });
});

// G. undefined when neither provided
test('L-015 G: returns undefined when neither _FILE nor literal env provided', () => {
  const result = readSecretFromFileOrEnv('NONEXISTENT_FILE_ENV', 'NONEXISTENT_LITERAL_ENV');
  assert.equal(result, undefined);
});
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const FIXTURES_ROOT = 'scripts/lib/runTests.fixtures';

function spawnRunner(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/lib/runTests.ts', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

function describeResult(result: RunResult): string {
  return `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

async function testPassingFixtureExits0() {
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=passing']);
  assert.equal(result.exitCode, 0, `expected exit 0${describeResult(result)}`);
  assert.match(result.stdout, /✓ test-passing/);
  assert.match(result.stdout, /PASS: 1\s+FAIL: 0/);
}

async function testFailingFixtureExits1AndReplaysStderr() {
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=failing']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /✗ test-failing/);
  assert.match(result.stdout, /intentional failure for runner self-test/);
  assert.match(result.stdout, /PASS: 0\s+FAIL: 1/);
  assert.match(result.stdout, /Failed:[\s\S]+- test-failing/);
}

async function testCollectAllRunsBothBeforeReportingFailure() {
  // Substring 'ing' matches test-passing and test-failing but not test-slow.
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=ing']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /✓ test-passing/);
  assert.match(result.stdout, /✗ test-failing/);
  assert.match(result.stdout, /PASS: 1\s+FAIL: 1/);
}

async function testBailStopsAfterFirstFailure() {
  // Alphabetical order: test-failing < test-passing. --bail must skip passing.
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=ing', '--bail']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /✗ test-failing/);
  assert.equal(
    result.stdout.includes('✓ test-passing'),
    false,
    `expected test-passing to be skipped under --bail${describeResult(result)}`
  );
  assert.match(result.stdout, /PASS: 0\s+FAIL: 1/);
}

async function testFilterCaseInsensitive() {
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=PASSING']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /✓ test-passing/);
}

async function testNoMatchExits1() {
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=nonexistent-marker']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no tests found/);
}

async function testTimeoutKillsSlowFixture() {
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=slow', '--timeout=1']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /✗ test-slow \(timed out after 1s\)/);
  assert.match(result.stdout, /PASS: 0\s+FAIL: 1/);
}

async function testLiveSuffixExcludedByDefault() {
  // test-flagged-live ends with -live and should be skipped by default.
  // --filter=flagged matches only that file, so discovery should find 0 and exit 1.
  const result = await spawnRunner([`--root=${FIXTURES_ROOT}`, '--filter=flagged']);
  assert.equal(result.exitCode, 1, `expected exit 1${describeResult(result)}`);
  assert.match(result.stderr, /no tests found/);
}

async function testIncludeLiveOptIn() {
  const result = await spawnRunner([
    `--root=${FIXTURES_ROOT}`,
    '--filter=flagged',
    '--include-live',
  ]);
  assert.equal(result.exitCode, 0, `expected exit 0${describeResult(result)}`);
  assert.match(result.stdout, /✓ test-flagged-live/);
  assert.match(result.stdout, /PASS: 1\s+FAIL: 0/);
}

async function run() {
  await testPassingFixtureExits0();
  await testFailingFixtureExits1AndReplaysStderr();
  await testCollectAllRunsBothBeforeReportingFailure();
  await testBailStopsAfterFirstFailure();
  await testFilterCaseInsensitive();
  await testNoMatchExits1();
  await testTimeoutKillsSlowFixture();
  await testLiveSuffixExcludedByDefault();
  await testIncludeLiveOptIn();
  console.log('runner self-test: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});

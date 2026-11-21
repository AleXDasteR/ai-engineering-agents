import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validatePlan, selectChecks, runCheck, changedFiles, saveReport } from '../lib/checks.mjs';

const execute = promisify(execFile);
const checks = [
  { id: 'code', command: '{node}', args: ['-e', 'console.log("ok")'], timeoutMs: 5000, paths: ['^src/'] },
  { id: 'docs', command: '{node}', args: ['-e', 'process.exit(0)'], timeoutMs: 5000, paths: ['^README'] },
];

test('change selection covers source, docs, unknown paths and no changes', () => {
  assert.deepEqual(selectChecks(checks, ['src/a.cs']).map(check => check.id), ['code']);
  assert.deepEqual(selectChecks(checks, ['README.md']).map(check => check.id), ['docs']);
  assert.equal(selectChecks(checks, ['new-component/a']).length, 2);
  assert.equal(selectChecks(checks, []).length, 0);
  assert.equal(selectChecks(checks, [], true).length, 2);
});

test('invalid plans fail before command execution', () => {
  assert.throws(() => validatePlan({ checks: [checks[0], checks[0]] }), /unique/);
  assert.throws(() => validatePlan({ checks: [{ ...checks[0], timeoutMs: 0 }] }), /timeoutMs/);
  assert.throws(() => validatePlan({ checks: [{ ...checks[0], paths: ['['] }] }));
});

test('runner preserves argument boundaries and reports a real nonzero exit', async () => {
  const result = await runCheck({ ...checks[0], args: ['-e', 'console.log(process.argv[1]); process.exit(3)', 'spaces ; literal'] },
    process.cwd(), { node: process.execPath });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout.trim(), 'spaces ; literal');
});

test('timeout fails the check and a missing executable is blocked', async () => {
  const timeout = await runCheck({ ...checks[0], timeoutMs: 250, args: ['-e', 'setInterval(()=>{},1000)'] },
    process.cwd(), { node: process.execPath });
  assert.equal(timeout.status, 'failed');
  assert.equal(timeout.timedOut, true);
  const missing = await runCheck({ ...checks[0], command: 'missing-agent-executable-92781' }, process.cwd(), {});
  assert.equal(missing.status, 'blocked');
});

test('reports remain valid across concurrent writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-report-'));
  try {
    const output = join(directory, 'result.json');
    await Promise.all([saveReport(output, { id: 1 }), saveReport(output, { id: 2 })]);
    assert.ok([1, 2].includes(JSON.parse(await readFile(output, 'utf8')).id));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CI includes staged, unstaged and untracked files, and rejects an invalid base', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-git-'));
  const git = args => execute('git', ['-C', directory, ...args]);
  try {
    await git(['init']);
    await writeFile(join(directory, 'tracked.txt'), 'initial');
    await git(['add', '.']);
    assert.deepEqual(await changedFiles(directory), ['tracked.txt']);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline']);
    assert.deepEqual(await changedFiles(directory), []);
    await writeFile(join(directory, 'tracked.txt'), 'changed');
    await writeFile(join(directory, 'staged.txt'), 'staged');
    await writeFile(join(directory, 'new.txt'), 'untracked');
    await git(['add', 'staged.txt']);
    assert.deepEqual(await changedFiles(directory), ['new.txt', 'staged.txt', 'tracked.txt']);
    await assert.rejects(changedFiles(directory, 'missing-reference'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const args = output => ['src/cli.mjs', '--vacancies', 'examples/vacancies.json',
  '--criteria', 'examples/criteria.json', '--journal', 'examples/journal.json', '--output', output];

test('CLI produces a valid report on concurrent retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-search-'));
  try {
    const output = join(directory, 'report.json');
    await Promise.all([run(process.execPath, args(output), { cwd: root }),
      run(process.execPath, args(output), { cwd: root })]);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.selected.length, 5);
    assert.equal(report.summary.rejected, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid input keeps an earlier report intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-search-'));
  try {
    const output = join(directory, 'report.json');
    const malformed = join(directory, 'invalid.json');
    await writeFile(output, 'previous report');
    await writeFile(malformed, '[{"id":false}]');
    const command = args(output);
    command[2] = malformed;
    await assert.rejects(run(process.execPath, command, { cwd: root }));
    assert.equal(await readFile(output, 'utf8'), 'previous report');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const names = ['llm-eval','rag-qa','mcp-tool-qa','ai-cost-monitor','incident-triage','agent-security-qa'];

for (const name of names) {
  test(name + ' CLI writes the expected report and preserves it on invalid input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-cli-'));
    try {
      const output = join(directory, 'report.json');
      const input = join(directory, 'input.json');
      await writeFile(input, await readFile(join(root, 'agents', name, 'example.json')));
      const args = [join(root, 'agents', name, 'run.mjs'), '--input', input, '--output', output];
      if (name === 'incident-triage') {
        await assert.rejects(execute(process.execPath, args), error => error.code === 1);
      } else await execute(process.execPath, args);
      const content = await readFile(output, 'utf8');
      const report = JSON.parse(content);
      assert.equal(report.agent, name);
      assert.equal(report.status, name === 'incident-triage' ? 'review' : 'passed');
      assert.match(report.inputSha256, /^[a-f0-9]{64}$/);
      await writeFile(input, 'null');
      await assert.rejects(execute(process.execPath, args), error => error.code === 2);
      assert.equal(await readFile(output, 'utf8'), content);
    } finally {
      assert.equal(dirname(directory), tmpdir());
      await rm(directory, { recursive: true, force: true });
    }
  });
}

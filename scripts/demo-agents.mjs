import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const demos = [
  ['llm-eval', 'passed'], ['rag-qa', 'passed'], ['mcp-tool-qa', 'passed'],
  ['ai-cost-monitor', 'passed'], ['incident-triage', 'review'], ['agent-security-qa', 'passed'],
];
for (const [name, expected] of demos) {
  const output = join(root, 'output', 'demos', name + '.json');
  let exitCode = 0;
  try {
    await execute(process.execPath, [join(root, 'agents', name, 'run.mjs'), '--input',
      join(root, 'agents', name, 'example.json'), '--output', output], { cwd: root });
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    exitCode = error.code;
  }
  const report = JSON.parse(await readFile(output, 'utf8'));
  const expectedExitCode = expected === 'passed' ? 0 : 1;
  if (report.agent !== name || report.status !== expected || exitCode !== expectedExitCode) {
    throw new Error(name + ' returned unexpected status or exit code');
  }
  console.log(name + ': ' + report.status + ' (expected ' + expected + ')');
}

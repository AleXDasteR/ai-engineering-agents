import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { saveReport } from './report.mjs';
export { saveReport } from './report.mjs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.checks) || plan.checks.length === 0) {
    throw new Error('Plan needs a nonempty checks array');
  }
  const ids = new Set();
  for (const check of plan.checks) {
    if (!check.id || typeof check.id !== 'string' || ids.has(check.id)) throw new Error('Check IDs must be unique strings');
    ids.add(check.id);
    if (typeof check.command !== 'string' || !check.command) throw new Error('Check needs an executable');
    if (!Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string')) throw new Error('Check args must be strings');
    if (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 3600000) throw new Error('timeoutMs must be 1..3600000');
    if (!Array.isArray(check.paths) || check.paths.length === 0) throw new Error('Check needs path patterns');
    for (const pattern of check.paths) {
      if (typeof pattern !== 'string') throw new Error('Path patterns must be regex strings');
      new RegExp(pattern);
    }
  }
}

export function selectChecks(checks, changedPaths, all = false) {
  if (all) return checks;
  if (!changedPaths.length) return [];
  // Unknown paths get the full suite so a newly added component is covered.
  if (changedPaths.some(path => !checks.some(check => check.paths.some(pattern => new RegExp(pattern).test(path))))) return checks;
  return checks.filter(check => changedPaths.some(path => check.paths.some(pattern => new RegExp(pattern).test(path))));
}

export async function changedFiles(project, base) {
  const git = args => execute('git', ['-C', project, ...args], { maxBuffer: 4 * 1024 * 1024 });
  await git(['rev-parse', '--show-toplevel']);
  let tracked;
  if (base) {
    // Invalid explicit revisions fail, instead of silently using a different baseline.
    await git(['rev-parse', '--verify', base + '^{commit}']);
    tracked = await git(['diff', '--name-only', '-z', base, '--']);
  } else {
    let hasHead = true;
    try {
      await git(['rev-parse', '--verify', 'HEAD']);
    } catch {
      hasHead = false;
    }
    tracked = await git(hasHead ? ['diff', '--name-only', '-z', 'HEAD', '--'] : ['ls-files', '--cached', '-z']);
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set((tracked.stdout + untracked.stdout).split('\0').filter(Boolean))].sort();
}

export function runCheck(check, project, variables) {
  const expand = text => text.replace(/\{([a-z]+)\}/gu, (_, name) => {
    if (!Object.hasOwn(variables, name)) throw new Error('Unknown placeholder {' + name + '}');
    return variables[name];
  });
  const command = expand(check.command);
  const args = check.args.map(expand);
  const start = Date.now();
  return new Promise(resolveResult => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let spawnError;
    const append = (previous, chunk) => {
      const next = previous + chunk.toString();
      if (next.length > 65536) truncated = true;
      return next.slice(-65536);
    };
    const child = spawn(command, args, {
      cwd: project, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => { spawnError = error.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      if (process.platform === 'win32' && child.exitCode !== null) {
        child.stdout.destroy();
        child.stderr.destroy();
        return;
      }
      if (process.platform === 'win32') {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
          if (error) child.kill();
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, check.timeoutMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      let status = exitCode === 0 ? 'passed' : 'failed';
      if (timedOut) status = 'failed';
      if (spawnError) status = 'blocked';
      resolveResult({
        id: check.id, status, exitCode, signal, timedOut, durationMs: Date.now() - start,
        command, args, stdout, stderr, truncated, error: spawnError ?? null,
      });
    });
  });
}

export async function runAgent(agent) {
  const { values } = parseArgs({ options: {
    project: { type: 'string' }, plan: { type: 'string' }, output: { type: 'string' },
    base: { type: 'string' }, all: { type: 'boolean', default: false }, hdt: { type: 'string' },
  } });
  if (!values.project || !values.plan || !values.output) {
    throw new Error('Required options: --project DIR --plan FILE --output DIR');
  }
  const project = resolve(values.project);
  const planPath = resolve(values.plan);
  const output = resolve(values.output);
  const reportPath = resolve(output, agent + '.json');
  if (reportPath === planPath) throw new Error('Report would overwrite plan');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  validatePlan(plan);
  const changed = agent === 'ci-test' && !values.all ? await changedFiles(project, values.base) : [];
  const selected = agent === 'product-qa' ? plan.checks : selectChecks(plan.checks, changed, values.all);
  const variables = { repo: repositoryRoot, project, output, node: process.execPath };
  if (values.hdt) variables.hdt = resolve(values.hdt);
  // Resolve all placeholders before starting any command.
  for (const check of selected) {
    for (const argument of [check.command, ...check.args]) {
      for (const match of argument.matchAll(/\{([a-z]+)\}/gu)) {
        if (!Object.hasOwn(variables, match[1])) throw new Error('Missing --' + match[1] + ' for ' + check.id);
      }
    }
  }
  await mkdir(output, { recursive: true });
  const results = [];
  for (const check of selected) results.push(await runCheck(check, project, variables));
  const failures = results.filter(result => result.status === 'failed').length;
  const blocked = results.filter(result => result.status === 'blocked').length;
  let status = results.length ? 'passed' : 'skipped';
  if (blocked) status = 'blocked';
  if (failures) status = 'failed';
  const report = {
    agent, status, observedAt: new Date().toISOString(), project,
    baseline: values.base ?? null, selection: values.all ? 'all' : agent === 'product-qa' ? 'scenarios' : 'changed-files',
    changedPaths: changed, selectedChecks: selected.map(check => check.id), results,
    summary: { passed: results.length - failures - blocked, failed: failures, blocked },
    manualChecks: plan.manualChecks ?? [],
  };
  await saveReport(reportPath, report);
  console.log(JSON.stringify({ agent, status, ...report.summary, report: reportPath }));
  if (failures || blocked) process.exitCode = 1;
  return report;
}

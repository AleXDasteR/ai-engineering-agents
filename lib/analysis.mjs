import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { saveReport } from './report.mjs';

export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  return value;
}

export function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be a nonempty string');
  return value;
}

export function number(value, label, maximum = Infinity) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(label + ' must be 0..' + maximum);
  return value;
}

export function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

export function array(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error(label + ' must be an array' + (allowEmpty ? '' : ' with entries'));
  return value;
}

export function uniqueRows(rows, label) {
  array(rows, label);
  const seen = new Set();
  for (const row of rows) {
    object(row, label);
    text(row.id, label + '.id');
    if (seen.has(row.id)) throw new Error('Duplicate ' + label + ' ID ' + row.id);
    seen.add(row.id);
  }
  return rows;
}

export function timestamp(value, label) {
  text(value, label);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !/T.*(?:Z|[+-]\d\d:\d\d)$/u.test(value)) {
    throw new Error(label + ' must be an ISO timestamp with timezone');
  }
  return parsed;
}

export function percentile95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

export function requestCost(request, prices) {
  object(request, 'request');
  text(request.model, 'request.model');
  const rate = object(prices[request.model], 'price for ' + request.model);
  number(rate.input, 'input price');
  number(rate.output, 'output price');
  const input = number(request.inputTokens, 'inputTokens');
  const output = number(request.outputTokens, 'outputTokens');
  const cached = number(request.cachedInputTokens ?? 0, 'cachedInputTokens', input);
  if (cached) number(rate.cachedInput, 'cached input price');
  return ((input - cached) * rate.input + cached * (rate.cachedInput ?? 0) + output * rate.output) / 1000000;
}

export async function runAnalysis(name, analyze) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
  if (!values.input || !values.output) throw new Error('Required: --input FILE --output FILE');
  const input = await realpath(resolve(values.input));
  const output = resolve(values.output);
  let existingOutput = output;
  try { existingOutput = await realpath(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (input === existingOutput) throw new Error('Output must differ from input');
  const source = await readFile(input, 'utf8');
  const report = analyze(JSON.parse(source));
  await saveReport(output, {
    agent: name, schemaVersion: 1, observedAt: new Date().toISOString(),
    inputSha256: createHash('sha256').update(source).digest('hex'), ...report,
  });
  console.log(JSON.stringify({ agent: name, status: report.status, report: output }));
  if (report.status !== 'passed') process.exitCode = 1;
}

export function entrypoint(name, analyze) {
  runAnalysis(name, analyze).catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}

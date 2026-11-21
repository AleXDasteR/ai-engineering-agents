import { object, text, number, boolean, array, uniqueRows } from '../../lib/analysis.mjs';
import { inspectSchema, validateValue } from './schema.mjs';

export function analyze(input) {
  object(input, 'input');
  const tools = array(input.tools, 'tools');
  const names = new Set();
  const byName = new Map();
  const unsupportedSchemas = [];
  for (const tool of tools) {
    object(tool, 'tool');
    text(tool.name, 'tool.name');
    if (names.has(tool.name)) throw new Error('Duplicate tool ' + tool.name);
    names.add(tool.name);
    if (!['read', 'write'].includes(tool.effect)) throw new Error('Tool effect must be read or write');
    boolean(tool.retrySafe, 'tool.retrySafe');
    const inputUnsupported = inspectSchema(tool.inputSchema);
    const outputUnsupported = tool.outputSchema == null ? [] : inspectSchema(tool.outputSchema);
    const unsupported = [...inputUnsupported, ...outputUnsupported];
    if (unsupported.length) unsupportedSchemas.push({ tool: tool.name, keywords: unsupported });
    if (tool.idempotencyKeyArgument != null) text(tool.idempotencyKeyArgument, 'idempotencyKeyArgument');
    byName.set(tool.name, { ...tool, inputUnsupported, outputUnsupported });
  }
  const cases = uniqueRows(input.cases, 'cases');
  const limits = object(input.limits, 'limits');
  number(limits.maximumDurationMs, 'maximumDurationMs');
  number(limits.maximumAttempts, 'maximumAttempts');
  const results = cases.map(testCase => {
    const tool = byName.get(testCase.tool);
    if (!tool) throw new Error('Unknown tool ' + testCase.tool);
    object(testCase.arguments, 'arguments');
    object(testCase.result, 'result');
    boolean(testCase.expectedInputValid, 'expectedInputValid');
    boolean(testCase.expectedError, 'expectedError');
    boolean(testCase.result.isError, 'result.isError');
    number(testCase.durationMs, 'durationMs');
    if (!Number.isInteger(testCase.attempts) || testCase.attempts < 1) throw new Error('attempts must be a positive integer');
    const issues = [];
    const argumentErrors = tool.inputUnsupported.length ? null : validateValue(tool.inputSchema, testCase.arguments);
    if (argumentErrors && (argumentErrors.length === 0) !== testCase.expectedInputValid) issues.push('input_contract');
    if (testCase.result.isError !== testCase.expectedError) issues.push('unexpected_error_status');
    if (!testCase.expectedInputValid && !testCase.result.isError) issues.push('invalid_input_accepted');
    let outputErrors = [];
    if (!testCase.result.isError && tool.outputSchema != null && !tool.outputUnsupported.length) {
      outputErrors = validateValue(tool.outputSchema, testCase.result.structuredContent);
      if (outputErrors.length) issues.push('output_contract');
    }
    if (testCase.durationMs > limits.maximumDurationMs) issues.push('duration_limit');
    if (testCase.attempts > limits.maximumAttempts) issues.push('attempt_limit');
    if (tool.effect === 'write' && testCase.attempts > 1) {
      if (!tool.retrySafe) issues.push('unsafe_write_retry');
      if (tool.idempotencyKeyArgument && !testCase.arguments[tool.idempotencyKeyArgument]) issues.push('missing_idempotency_key');
    }
    return { id: testCase.id, tool: tool.name, issues, argumentErrors, outputErrors, outputSchemaProvided: tool.outputSchema != null };
  });
  let status = unsupportedSchemas.length ? 'review' : 'passed';
  if (results.some(result => result.issues.length)) status = 'failed';
  return {
    status, results, unsupportedSchemas,
    transport: 'Recorded MCP/tool calls. Protocol transport and server availability require a live integration check.',
  };
}

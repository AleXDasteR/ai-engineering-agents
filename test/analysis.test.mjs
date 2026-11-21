import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze as evaluate } from '../agents/llm-eval/analyze.mjs';
import { analyze as rag } from '../agents/rag-qa/analyze.mjs';
import { analyze as tools } from '../agents/mcp-tool-qa/analyze.mjs';
import { validateValue } from '../agents/mcp-tool-qa/schema.mjs';
import { analyze as costs } from '../agents/ai-cost-monitor/analyze.mjs';
import { analyze as triage, redact } from '../agents/incident-triage/analyze.mjs';
import { analyze as security } from '../agents/agent-security-qa/analyze.mjs';
import { requestCost } from '../lib/analysis.mjs';

const fixture = name => JSON.parse(readFileSync(new URL('../agents/' + name + '/example.json', import.meta.url), 'utf8'));

test('LLM eval chooses the cheapest model that satisfies every gate', () => {
  const result = evaluate(fixture('llm-eval'));
  assert.equal(result.recommendedModel, 'small-demo');
  assert.equal(result.results[0].exactMatch, 1);
  assert.equal(result.results[0].p95LatencyMs, 110);
});

test('incomplete model coverage cannot win with an artificially cheap sample', () => {
  const input = fixture('llm-eval');
  input.runs = input.runs.filter(run => run.id !== 'a2');
  const result = evaluate(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.recommendedModel, null);
  assert.ok(result.results[0].issues.includes('incomplete_coverage'));
});

test('duplicate model/case observations and unknown case IDs fail validation', () => {
  const input = fixture('llm-eval');
  input.runs.push({ ...input.runs[0], id: 'duplicate' });
  assert.throws(() => evaluate(input), /Repeated/);
  input.runs.pop();
  input.runs[0].caseId = 'not-in-reference';
  assert.throws(() => evaluate(input), /Unknown case/);
});

test('LLM request errors and latency fail an otherwise matching model', () => {
  const input = fixture('llm-eval');
  input.runs[0].error = 'upstream timeout';
  input.runs[1].latencyMs = 1000;
  assert.equal(evaluate(input).recommendedModel, null);
});

test('missing model prices and nonnumeric usage fail before metrics are calculated', () => {
  const input = fixture('llm-eval');
  delete input.pricesUsdPerMillion['small-demo'];
  assert.throws(() => evaluate(input), /price/);
  input.pricesUsdPerMillion['small-demo'] = { input: 1, output: 2 };
  input.runs[0].inputTokens = '100';
  assert.throws(() => evaluate(input), /inputTokens/);
});

test('RAG distinguishes answerable and abstention cases', () => {
  const result = rag(fixture('rag-qa'));
  assert.equal(result.status, 'passed');
  assert.equal(result.meanRecall, 1);
  assert.equal(result.results[1].recall, null);
});

test('RAG flags fabricated quotes and citations outside retrieved context', () => {
  const input = fixture('rag-qa');
  input.cases[0].citations[0].quote = 'несуществующая цитата';
  input.cases[0].retrievedDocumentIds = [];
  const result = rag(input);
  assert.ok(result.results[0].issues.includes('unverified_quote:rules'));
  assert.ok(result.results[0].issues.includes('citation_outside_retrieval:rules'));
  assert.equal(result.status, 'failed');
});

test('RAG flags stale sources and duplicate retrievals', () => {
  const input = fixture('rag-qa');
  input.now = '2027-11-21T00:00:00Z';
  input.cases[0].retrievedDocumentIds.push('rules');
  const result = rag(input);
  assert.ok(result.results[0].issues.includes('stale_document:rules'));
  assert.ok(result.results[0].issues.includes('duplicate_retrieval'));
});

test('RAG detects an answer to an unanswerable question and a silent empty answer', () => {
  const input = fixture('rag-qa');
  input.cases[1].abstained = false;
  input.cases[0].answer = '';
  const result = rag(input);
  assert.ok(result.results[1].issues.includes('answer_without_reference'));
  assert.ok(result.results[0].issues.includes('empty_answer'));
});

test('RAG rejects future source timestamps and unknown reference documents', () => {
  const input = fixture('rag-qa');
  input.documents[0].updatedAt = '2028-01-01T00:00:00Z';
  assert.throws(() => rag(input), /future/);
  input.documents[0].updatedAt = '2026-11-20T00:00:00Z';
  input.cases[0].expectedDocumentIds = ['missing'];
  assert.throws(() => rag(input), /Unknown reference/);
});

test('tool QA accepts an intentionally rejected invalid-input case', () => {
  assert.equal(tools(fixture('mcp-tool-qa')).status, 'passed');
});

test('tool QA detects invalid output and invalid input accepted by a tool', () => {
  const input = fixture('mcp-tool-qa');
  input.cases[0].result.structuredContent = { found: 'yes' };
  input.cases[1].result.isError = false;
  const result = tools(input);
  assert.ok(result.results[0].issues.includes('output_contract'));
  assert.ok(result.results[1].issues.includes('invalid_input_accepted'));
});

test('unsupported schema keywords require explicit review', () => {
  const input = fixture('mcp-tool-qa');
  input.tools[0].inputSchema.properties.id.format = 'uuid';
  const result = tools(input);
  assert.equal(result.status, 'review');
  assert.ok(result.unsupportedSchemas[0].keywords.some(path => path.endsWith('.format')));
});

test('unsupported input schema does not suppress a known output violation', () => {
  const input = fixture('mcp-tool-qa');
  input.tools[0].inputSchema.properties.id.format = 'uuid';
  input.cases[0].result.structuredContent = { found: 'invalid boolean' };
  assert.equal(tools(input).status, 'failed');
});

test('tool QA detects unsafe retry of a write operation', () => {
  const input = fixture('mcp-tool-qa');
  input.tools[0].effect = 'write';
  input.tools[0].retrySafe = false;
  input.cases[0].attempts = 2;
  assert.ok(tools(input).results[0].issues.includes('unsafe_write_retry'));
});

test('schema object enums do not depend on JSON property order', () => {
  assert.deepEqual(validateValue({ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 }), []);
  assert.ok(validateValue({ type: 'array', items: { type: 'integer' } }, [1, '2']).length);
});

test('cost accounting bills cached input once and requires a cached-token price', () => {
  const input = fixture('ai-cost-monitor');
  const request = input.current.requests[0];
  assert.ok(Math.abs(requestCost(request, input.pricesUsdPerMillion) - 0.0008) < 1e-12);
  delete input.pricesUsdPerMillion['demo-model'].cachedInput;
  assert.throws(() => costs(input), /cached input price/);
});

test('cost monitor normalizes growth per request as traffic changes', () => {
  const input = fixture('ai-cost-monitor');
  input.current.requests.push({ ...input.current.requests[0], id: 'c3' });
  const result = costs(input);
  assert.ok(Math.abs(result.growthRatio - 1) < 1e-12);
  assert.equal(result.status, 'passed');
});

test('cost monitor reports cost, latency and error regressions together', () => {
  const input = fixture('ai-cost-monitor');
  input.current.requests[0].outputTokens = 50000;
  input.current.requests[0].latencyMs = 2000;
  input.current.requests[0].success = false;
  const result = costs(input);
  for (const alert of ['cost_growth', 'p95_latency', 'error_rate', 'cost_per_request']) assert.ok(result.alerts.includes(alert));
});

test('cost monitor rejects impossible cache counts and empty windows', () => {
  const input = fixture('ai-cost-monitor');
  input.current.requests[0].cachedInputTokens = 1001;
  assert.throws(() => costs(input), /cachedInputTokens/);
  input.current.requests = [];
  assert.throws(() => costs(input), /requests/);
});

test('zero baseline spend never produces an infinite growth ratio', () => {
  const input = fixture('ai-cost-monitor');
  for (const request of input.baseline.requests) {
    request.inputTokens = 0; request.cachedInputTokens = 0; request.outputTokens = 0;
  }
  const result = costs(input);
  assert.equal(result.growthRatio, null);
  assert.ok(result.alerts.includes('zero_baseline_cost'));
});

test('triage groups related events and keeps causes as hypotheses', () => {
  const result = triage(fixture('incident-triage'));
  assert.equal(result.status, 'review');
  assert.equal(result.incidents[0].count, 2);
  assert.equal(result.incidents[0].confidence, 'hypothesis');
  assert.deepEqual(result.actionsExecuted, []);
  assert.ok(!JSON.stringify(result).includes('DEMO_NOT_A_REAL_SECRET'));
});

test('triage masks credentials in structured JSON and URL query strings', () => {
  const result = redact('{"api_key":"quoted secret value"} token=x https://demo:pass@example.invalid/?access_token=hidden');
  assert.ok(!result.includes('quoted secret value'));
  assert.ok(!result.includes('demo:pass'));
  assert.ok(!result.includes('hidden'));
});

test('triage sorts event window by timestamps instead of input order', () => {
  const input = fixture('incident-triage');
  input.events.reverse();
  const incident = triage(input).incidents[0];
  assert.equal(incident.firstSeen, '2026-11-21T00:00:01Z');
  assert.equal(incident.lastSeen, '2026-11-21T00:00:02Z');
});

test('unknown error signatures require review with source evidence', () => {
  const input = fixture('incident-triage');
  input.events[1].message = 'Unrecognized application failure';
  const result = triage(input);
  assert.ok(result.incidents.some(incident => incident.code === 'unclassified' && incident.evidence.length));
});

test('empty logs require review instead of claiming a healthy service', () => {
  assert.equal(triage({ events: [] }).status, 'review');
});

test('security QA counts blocked attacks without treating them as successful writes', () => {
  const result = security(fixture('agent-security-qa'));
  assert.equal(result.status, 'passed');
  assert.equal(result.results[0].preventedCalls, 1);
});

test('security QA detects executed exfiltration and unauthorized tool use', () => {
  const input = fixture('agent-security-qa');
  input.cases[0].observed.toolCalls[0].executed = true;
  const result = security(input);
  assert.equal(result.status, 'failed');
  assert.ok(result.results[0].violations.includes('canary_in_external_arguments:0'));
  assert.ok(result.results[0].violations.includes('external_write:0'));
});

test('security QA detects canaries in answers even without a tool call', () => {
  const input = fixture('agent-security-qa');
  input.cases[0].observed.response = input.cases[0].canary;
  assert.ok(security(input).results[0].violations.includes('canary_in_response'));
});

test('security QA marks missing egress evidence as review', () => {
  const input = fixture('agent-security-qa');
  const testCase = input.cases[0];
  testCase.policy.allowedTools = ['send_message'];
  testCase.policy.allowExternalWrites = true;
  const call = testCase.observed.toolCalls[0];
  call.executed = true;
  call.arguments = { body: 'public text' };
  delete call.destination;
  assert.equal(security(input).status, 'review');
});

test('security QA compares complete hostnames and rejects lookalike destinations', () => {
  const input = fixture('agent-security-qa');
  const testCase = input.cases[0];
  testCase.policy = { allowedTools: ['send_message'], allowedDestinations: ['trusted.example'], allowExternalWrites: true };
  testCase.observed.toolCalls[0] = { tool: 'send_message', arguments: { body: 'public' },
    executed: true, destination: 'https://trusted.example.evil.invalid' };
  assert.equal(security(input).status, 'failed');
});

test('security policy and tool-call execution flags must be explicit', () => {
  const input = fixture('agent-security-qa');
  delete input.cases[0].observed.toolCalls[0].executed;
  assert.throws(() => security(input), /executed/);
});

import { object, text, number, uniqueRows, percentile95, requestCost } from '../../lib/analysis.mjs';

export function analyze(input) {
  object(input, 'input');
  const cases = uniqueRows(input.cases, 'cases');
  const runs = uniqueRows(input.runs, 'runs');
  object(input.pricesUsdPerMillion, 'pricesUsdPerMillion');
  const limits = object(input.thresholds, 'thresholds');
  number(limits.minimumExactMatch, 'minimumExactMatch', 1);
  number(limits.maximumP95LatencyMs, 'maximumP95LatencyMs');
  number(limits.maximumTotalCostUsd, 'maximumTotalCostUsd');
  const expected = new Map();
  for (const testCase of cases) {
    if (typeof testCase.expected !== 'string') throw new Error('expected must be a string');
    expected.set(testCase.id, testCase.expected);
  }
  const models = new Map();
  const seen = new Set();
  for (const run of runs) {
    text(run.model, 'model');
    if (!expected.has(run.caseId)) throw new Error('Unknown case ' + run.caseId);
    const key = JSON.stringify([run.model, run.caseId]);
    if (seen.has(key)) throw new Error('Repeated model/case observation ' + key);
    seen.add(key);
    number(run.latencyMs, 'latencyMs');
    if (typeof run.output !== 'string') throw new Error('output must be a string');
    if (run.error != null) text(run.error, 'error');
    const cost = requestCost(run, input.pricesUsdPerMillion);
    if (!models.has(run.model)) models.set(run.model, []);
    models.get(run.model).push({
      caseId: run.caseId, matched: !run.error && run.output === expected.get(run.caseId),
      error: run.error ?? null, costUsd: cost, latencyMs: run.latencyMs,
    });
  }
  const results = [];
  for (const [model, observations] of models) {
    const missingCases = cases.filter(testCase => !observations.some(run => run.caseId === testCase.id)).map(testCase => testCase.id);
    const exactMatch = observations.filter(run => run.matched).length / cases.length;
    const costUsd = observations.reduce((sum, run) => sum + run.costUsd, 0);
    const p95LatencyMs = percentile95(observations.map(run => run.latencyMs));
    const issues = [];
    if (missingCases.length) issues.push('incomplete_coverage');
    if (observations.some(run => run.error)) issues.push('request_errors');
    if (exactMatch < limits.minimumExactMatch) issues.push('exact_match_below_threshold');
    if (costUsd > limits.maximumTotalCostUsd) issues.push('cost_above_budget');
    if (p95LatencyMs > limits.maximumP95LatencyMs) issues.push('latency_above_threshold');
    results.push({ model, exactMatch, costUsd, p95LatencyMs, missingCases, issues, observations });
  }
  const eligible = results.filter(result => result.issues.length === 0)
    .sort((a, b) => a.costUsd - b.costUsd || b.exactMatch - a.exactMatch || a.model.localeCompare(b.model));
  return {
    status: eligible.length ? 'passed' : 'failed',
    recommendedModel: eligible[0]?.model ?? null, cases: cases.length, results,
    qualityMethod: 'Exact string match against reference outputs. Semantic quality requires separate review.',
  };
}

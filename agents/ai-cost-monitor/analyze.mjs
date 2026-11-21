import { object, number, boolean, uniqueRows, percentile95, requestCost } from '../../lib/analysis.mjs';

function measure(window, prices) {
  object(window, 'window');
  number(window.seconds, 'window.seconds');
  if (window.seconds === 0) throw new Error('window.seconds must be positive');
  const requests = uniqueRows(window.requests, 'requests');
  const models = new Map();
  let totalCostUsd = 0;
  for (const request of requests) {
    boolean(request.success, 'request.success');
    number(request.latencyMs, 'latencyMs');
    const cost = requestCost(request, prices);
    totalCostUsd += cost;
    const model = models.get(request.model) ?? { requests: 0, costUsd: 0 };
    model.requests++;
    model.costUsd += cost;
    models.set(request.model, model);
  }
  return {
    requests: requests.length, totalCostUsd, costPerRequestUsd: totalCostUsd / requests.length,
    projectedCostPerHourUsd: totalCostUsd / window.seconds * 3600,
    p95LatencyMs: percentile95(requests.map(request => request.latencyMs)),
    errorRate: requests.filter(request => !request.success).length / requests.length,
    byModel: Object.fromEntries(models),
  };
}

export function analyze(input) {
  object(input, 'input');
  const prices = object(input.pricesUsdPerMillion, 'pricesUsdPerMillion');
  const budgets = object(input.budgets, 'budgets');
  for (const field of ['maximumCostPerHourUsd', 'maximumCostPerRequestUsd', 'maximumP95LatencyMs', 'maximumCostGrowthRatio']) number(budgets[field], field);
  number(budgets.maximumErrorRate, 'maximumErrorRate', 1);
  const current = measure(input.current, prices);
  const baseline = measure(input.baseline, prices);
  const growthRatio = baseline.costPerRequestUsd === 0 ? null : current.costPerRequestUsd / baseline.costPerRequestUsd;
  const alerts = [];
  if (current.projectedCostPerHourUsd > budgets.maximumCostPerHourUsd) alerts.push('hourly_cost');
  if (current.costPerRequestUsd > budgets.maximumCostPerRequestUsd) alerts.push('cost_per_request');
  if (current.p95LatencyMs > budgets.maximumP95LatencyMs) alerts.push('p95_latency');
  if (current.errorRate > budgets.maximumErrorRate) alerts.push('error_rate');
  if (growthRatio !== null && growthRatio > budgets.maximumCostGrowthRatio) alerts.push('cost_growth');
  if (growthRatio === null && current.costPerRequestUsd > 0) alerts.push('zero_baseline_cost');
  return {
    status: alerts.length ? 'failed' : 'passed', current, baseline, growthRatio, alerts,
    pricingMethod: 'User-supplied USD per million tokens. inputTokens includes cachedInputTokens.',
  };
}

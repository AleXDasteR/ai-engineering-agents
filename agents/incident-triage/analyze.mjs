import { object, text, array, timestamp } from '../../lib/analysis.mjs';

export function redact(message) {
  return message
    .replace(/\bBearer\s+[^\s"',;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*(["'])(.*?)\2/giu, '$1=[REDACTED]')
    .replace(/\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*["']?[^\s"',;&}]+/giu, '$1=[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[EMAIL]');
}

const rules = [
  { code: 'storage_capacity', pattern: /ENOSPC|no space left on device/iu,
    hypothesis: 'Storage capacity or quota may be exhausted.',
    nextSteps: ['Check free space and filesystem quota in the affected runtime.', 'Compare growth of logs, temporary files and artifacts with the incident window.'] },
  { code: 'rate_limit', pattern: /\b429\b|rate.?limit|too many requests/iu,
    hypothesis: 'An upstream or local request quota may have been reached.',
    nextSteps: ['Inspect quota headers, retry-after and request volume.', 'Check bounded retries and backoff settings.'] },
  { code: 'authentication', pattern: /\b401\b|invalid.?api.?key|unauthorized/iu,
    hypothesis: 'The affected request may have missing, expired or inappropriate credentials.',
    nextSteps: ['Check credential presence and scope through the secret manager.', 'Compare deployment configuration with the last successful revision.'] },
  { code: 'connectivity', pattern: /ECONNREFUSED|ENOTFOUND|connection refused|name resolution/iu,
    hypothesis: 'The endpoint may be unavailable or incorrectly configured.',
    nextSteps: ['Check endpoint configuration, DNS and service readiness.', 'Compare failures across services and trace IDs.'] },
  { code: 'timeout', pattern: /ETIMEDOUT|timed? ?out|timeout/iu,
    hypothesis: 'The operation may be waiting on a slow dependency or resource contention.',
    nextSteps: ['Inspect dependency latency and saturation over the same time window.', 'Check timeout budgets across the request chain.'] },
];

export function analyze(input) {
  object(input, 'input');
  const events = array(input.events, 'events', true);
  const groups = new Map();
  let ignored = 0;
  events.forEach((event, index) => {
    object(event, 'event');
    const at = timestamp(event.timestamp, 'event.timestamp');
    text(event.service, 'event.service');
    text(event.message, 'event.message');
    if (!['debug', 'info', 'warn', 'error', 'fatal'].includes(event.level)) throw new Error('Unsupported log level');
    if (!['error', 'fatal', 'warn'].includes(event.level)) { ignored++; return; }
    const rule = rules.find(candidate => candidate.pattern.test(event.message));
    const code = rule?.code ?? 'unclassified';
    const key = JSON.stringify([event.service, code]);
    if (!groups.has(key)) groups.set(key, {
      service: redact(event.service), code, severity: 'warning', count: 0,
      firstSeen: event.timestamp, lastSeen: event.timestamp, firstAt: at, lastAt: at,
      hypothesis: rule?.hypothesis ?? 'The available rules cannot establish a cause.',
      confidence: 'hypothesis', nextSteps: rule?.nextSteps ?? ['Inspect the originating code path and correlate surrounding events.'],
      evidence: [],
    });
    const group = groups.get(key);
    group.count++;
    if (event.level === 'fatal' || event.level === 'error') group.severity = 'error';
    if (at < group.firstAt) { group.firstAt = at; group.firstSeen = event.timestamp; }
    if (at > group.lastAt) { group.lastAt = at; group.lastSeen = event.timestamp; }
    if (group.evidence.length < 5) group.evidence.push({
      eventIndex: index, timestamp: event.timestamp, message: redact(event.message).slice(0,2000),
      traceId: event.traceId == null ? null : redact(text(event.traceId, 'traceId')),
    });
  });
  const incidents = [...groups.values()].map(({ firstAt, lastAt, ...group }) => group);
  return {
    status: incidents.length || !events.length ? 'review' : 'passed', events: events.length, ignored, incidents,
    actionsExecuted: [],
    redaction: 'Common credential assignments, bearer tokens, URL credentials and emails are masked. Review logs before sharing.',
  };
}

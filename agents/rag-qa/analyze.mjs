import { object, text, number, boolean, array, uniqueRows, timestamp } from '../../lib/analysis.mjs';

export function analyze(input) {
  object(input, 'input');
  const now = timestamp(input.now, 'now');
  const documents = uniqueRows(input.documents, 'documents');
  const cases = uniqueRows(input.cases, 'cases');
  const limits = object(input.thresholds, 'thresholds');
  number(limits.minimumRecall, 'minimumRecall', 1);
  number(limits.maximumDocumentAgeDays, 'maximumDocumentAgeDays');
  const byId = new Map();
  for (const document of documents) {
    text(document.text, 'document.text');
    const updated = timestamp(document.updatedAt, 'updatedAt');
    if (updated > now) throw new Error('Document timestamp is in the future');
    byId.set(document.id, { ...document, ageDays: (now - updated) / 86400000 });
  }
  const results = cases.map(testCase => {
    array(testCase.expectedDocumentIds, 'expectedDocumentIds', true).forEach(id => text(id, 'expected document ID'));
    array(testCase.retrievedDocumentIds, 'retrievedDocumentIds', true).forEach(id => text(id, 'retrieved document ID'));
    array(testCase.citations, 'citations', true);
    boolean(testCase.abstained, 'abstained');
    if (typeof testCase.answer !== 'string') throw new Error('answer must be a string');
    const expected = new Set(testCase.expectedDocumentIds);
    const retrieved = new Set(testCase.retrievedDocumentIds);
    for (const id of expected) if (!byId.has(id)) throw new Error('Unknown reference document ' + id);
    const issues = [];
    if (retrieved.size !== testCase.retrievedDocumentIds.length) issues.push('duplicate_retrieval');
    for (const id of retrieved) {
      const document = byId.get(id);
      if (!document) issues.push('unknown_retrieved_document:' + id);
      else if (document.ageDays > limits.maximumDocumentAgeDays) issues.push('stale_document:' + id);
    }
    const recall = expected.size ? [...expected].filter(id => retrieved.has(id)).length / expected.size : null;
    const firstHit = testCase.retrievedDocumentIds.findIndex(id => expected.has(id));
    const reciprocalRank = firstHit < 0 ? 0 : 1 / (firstHit + 1);
    if (recall !== null && recall < limits.minimumRecall) issues.push('low_recall');
    if (!expected.size && !testCase.abstained) issues.push('answer_without_reference');
    if (expected.size && testCase.abstained) issues.push('unexpected_abstention');
    if (!testCase.abstained && !testCase.answer.trim()) issues.push('empty_answer');
    if (!testCase.abstained && !testCase.citations.length) issues.push('missing_citations');
    if (testCase.abstained && testCase.citations.length) issues.push('abstention_with_citations');
    for (const citation of testCase.citations) {
      object(citation, 'citation');
      text(citation.documentId, 'citation.documentId');
      text(citation.quote, 'citation.quote');
      const document = byId.get(citation.documentId);
      if (!document || !document.text.includes(citation.quote)) issues.push('unverified_quote:' + citation.documentId);
      if (!retrieved.has(citation.documentId)) issues.push('citation_outside_retrieval:' + citation.documentId);
    }
    return { id: testCase.id, recall, reciprocalRank, issues };
  });
  const scored = results.filter(result => result.recall !== null);
  return {
    status: results.some(result => result.issues.length) ? 'failed' : 'passed', results,
    meanRecall: scored.length ? scored.reduce((sum, result) => sum + result.recall, 0) / scored.length : null,
    meanReciprocalRank: scored.length ? scored.reduce((sum, result) => sum + result.reciprocalRank, 0) / scored.length : null,
    semanticSupport: 'Quote matching verifies source presence. Claim entailment requires separate review.',
  };
}

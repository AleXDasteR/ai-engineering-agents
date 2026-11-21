// Vacancy descriptions are untrusted source material. This module never executes them.
const seniorTitle = /\b(senior|lead|head|principal|staff|architect|CTO)\b|старш|ведущ|руковод|архитектор/iu;
const relatedTitle = /\b(python|fastapi|LLM|RAG|AI)\b|ИИ|автоматизац|интеграц/iu;

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a nonempty string`);
  }
}

function requireNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative number`);
  }
}

export function companyKey(name) {
  return name.normalize('NFKC').toLocaleLowerCase('ru')
    .replace(/\b(llc|ltd)\b|(?:^|\s)(?:ооо|ип)(?=\s|$)/giu, ' ')
    .replace(/[«»"'.,()]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function validateCriteria(criteria) {
  requireObject(criteria, 'criteria');
  requireNumber(criteria.minimumSalaryRub, 'minimumSalaryRub');
  requireNumber(criteria.maximumRequiredYears, 'maximumRequiredYears');
  if (!Number.isInteger(criteria.limit) || criteria.limit < 1) {
    throw new Error('limit must be a positive integer');
  }
  requireString(criteria.officeCity, 'officeCity');
  for (const field of ['allowedContracts', 'primaryStacks']) {
    if (!Array.isArray(criteria[field]) || !criteria[field].length) {
      throw new Error(`${field} must be a nonempty array`);
    }
    criteria[field].forEach(value => requireString(value, field));
  }
  requireObject(criteria.fxToRub, 'fxToRub');
  for (const rate of Object.values(criteria.fxToRub)) {
    requireNumber(rate, 'exchange rate');
    if (rate === 0) throw new Error('exchange rate must be positive');
  }
}

function validateVacancy(vacancy) {
  requireObject(vacancy, 'vacancy');
  for (const field of ['id', 'title', 'company', 'url']) {
    requireString(vacancy[field], `vacancy.${field}`);
  }
  if (!companyKey(vacancy.company)) throw new Error('company must contain a name');
  const url = new URL(vacancy.url);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('vacancy.url must use HTTPS without credentials');
  }
  for (const field of ['companyId', 'description', 'contract', 'primaryStack', 'city']) {
    if (vacancy[field] != null) requireString(vacancy[field], `vacancy.${field}`);
  }
  if (vacancy.remote != null && typeof vacancy.remote !== 'boolean') {
    throw new Error('vacancy.remote must be boolean or null');
  }
  if (vacancy.descriptionRead != null && typeof vacancy.descriptionRead !== 'boolean') {
    throw new Error('vacancy.descriptionRead must be boolean');
  }
  if (vacancy.requiredYears != null) requireNumber(vacancy.requiredYears, 'requiredYears');
  if (vacancy.salary != null) {
    requireObject(vacancy.salary, 'salary');
    requireString(vacancy.salary.currency, 'salary.currency');
    for (const field of ['from', 'to']) {
      if (vacancy.salary[field] != null) requireNumber(vacancy.salary[field], `salary.${field}`);
    }
    if (vacancy.salary.from == null && vacancy.salary.to == null) {
      throw new Error('salary needs from or to, or must be null');
    }
    if (vacancy.salary.from != null && vacancy.salary.to != null && vacancy.salary.from > vacancy.salary.to) {
      throw new Error('salary.from exceeds salary.to');
    }
  }
}

function knownEmployer(vacancy, journal) {
  return journal.some(entry => entry.vacancyId === vacancy.id
    || (vacancy.companyId && entry.companyId === vacancy.companyId)
    || companyKey(entry.company) === companyKey(vacancy.company));
}

function screenVacancy(vacancy, criteria, journal = []) {
  validateVacancy(vacancy);
  const reasons = [];
  const missing = [];
  if (knownEmployer(vacancy, journal)) reasons.push('already_in_journal');
  if (seniorTitle.test(vacancy.title)) reasons.push('seniority');
  if (!relatedTitle.test(vacancy.title)) missing.push('role_fit');
  if (vacancy.requiredYears == null) missing.push('required_years');
  else if (vacancy.requiredYears > criteria.maximumRequiredYears) reasons.push('required_years');
  if (vacancy.remote == null) missing.push('work_format');
  else if (!vacancy.remote) {
    if (!vacancy.city) missing.push('city');
    else if (companyKey(vacancy.city) !== companyKey(criteria.officeCity)) reasons.push('location');
  }
  if (!vacancy.contract) missing.push('contract');
  else if (!criteria.allowedContracts.includes(vacancy.contract)) reasons.push('contract');
  if (!vacancy.primaryStack) missing.push('primary_stack');
  else if (!criteria.primaryStacks.includes(vacancy.primaryStack)) reasons.push('primary_stack');
  if (!vacancy.descriptionRead || !vacancy.description?.trim()) missing.push('full_description');
  if (vacancy.salary) {
    if (vacancy.salaryPeriod && vacancy.salaryPeriod !== 'month') missing.push('salary_period');
    const rate = criteria.fxToRub[vacancy.salary.currency];
    if (rate == null) missing.push('currency_rate');
    else if (vacancy.salary.to != null && vacancy.salary.to * rate < criteria.minimumSalaryRub) reasons.push('salary');
    else if (vacancy.salary.to == null && vacancy.salary.from * rate < criteria.minimumSalaryRub) missing.push('salary_upper_bound');
  }
  let decision = 'eligible';
  if (missing.length) decision = 'review';
  if (reasons.length) decision = 'rejected';
  return { ...vacancy, decision, reasons, missing };
}

export function shortlist(vacancies, criteria, journal = []) {
  validateCriteria(criteria);
  if (!Array.isArray(vacancies) || !Array.isArray(journal)) {
    throw new Error('vacancies and journal must be arrays');
  }
  for (const entry of journal) {
    requireObject(entry, 'journal entry');
    requireString(entry.company, 'journal.company');
    if (entry.companyId != null) requireString(entry.companyId, 'journal.companyId');
    if (entry.vacancyId != null) requireString(entry.vacancyId, 'journal.vacancyId');
  }
  const seenIds = new Set();
  const selectedCompanies = new Set();
  const selectedCompanyIds = new Set();
  const decisions = [];
  const selected = [];
  // Preserve the user's search order. No opaque relevance score or LLM tie-break.
  for (const vacancy of vacancies) {
    const result = screenVacancy(vacancy, criteria, journal);
    if (seenIds.has(result.id)) {
      result.decision = 'rejected';
      result.reasons.push('duplicate_vacancy');
    }
    seenIds.add(result.id);
    const company = companyKey(result.company);
    if (result.decision === 'eligible' && (selectedCompanies.has(company)
      || (result.companyId && selectedCompanyIds.has(result.companyId)))) {
      result.decision = 'rejected';
      result.reasons.push('duplicate_company_in_shortlist');
    }
    if (result.decision === 'eligible' && selected.length < criteria.limit) {
      selected.push(result);
      selectedCompanies.add(company);
      if (result.companyId) selectedCompanyIds.add(result.companyId);
    }
    decisions.push(result);
  }
  return {
    selected,
    decisions,
    summary: {
      scanned: decisions.length,
      selected: selected.length,
      review: decisions.filter(item => item.decision === 'review').length,
      rejected: decisions.filter(item => item.decision === 'rejected').length,
      remaining: decisions.filter(item => item.decision === 'eligible').length - selected.length,
    },
  };
}

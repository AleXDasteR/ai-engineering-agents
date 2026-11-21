import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { saveReport } from '../lib/report.mjs';
import { parseArgs } from 'node:util';
import { shortlist } from './screen.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    vacancies: { type: 'string' }, criteria: { type: 'string' },
    journal: { type: 'string' }, output: { type: 'string' },
  } });
  if (!values.vacancies || !values.criteria || !values.output) {
    throw new Error('Usage: node src/cli.mjs --vacancies FILE --criteria FILE [--journal FILE] --output FILE');
  }
  const inputPaths = [values.vacancies, values.criteria, values.journal].filter(Boolean).map(path => resolve(path));
  const outputPath = resolve(values.output);
  if (inputPaths.includes(outputPath)) throw new Error('Output must differ from every input');
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  const [vacancies, criteria, journal] = await Promise.all([
    readJson(values.vacancies), readJson(values.criteria),
    values.journal ? readJson(values.journal) : [],
  ]);
  const result = shortlist(vacancies, criteria, journal);
  await saveReport(outputPath, result);
  console.log(JSON.stringify(result.summary));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

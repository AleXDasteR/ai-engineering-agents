import { entrypoint } from '../../lib/analysis.mjs';
import { analyze } from './analyze.mjs';
entrypoint('incident-triage', analyze);

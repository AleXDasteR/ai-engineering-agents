import { runAgent } from '../../lib/checks.mjs';

runAgent('ci-test').catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

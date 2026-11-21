import { runAgent } from '../../lib/checks.mjs';

runAgent('product-qa').catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

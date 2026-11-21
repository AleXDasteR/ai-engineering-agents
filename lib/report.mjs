import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function saveReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporaryPath, path);
        return;
      } catch (error) {
        // Windows can transiently lock the destination during another rename or a file scan.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

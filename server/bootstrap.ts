import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

export const serviceUrl = 'http://127.0.0.1:' + (process.env.MIVO_WORKFLOW_PORT ?? '9531');
let starting: Promise<void> | undefined;
async function healthy() {
  try {
    const response = await fetch(serviceUrl + '/local-api/health', {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok && (await response.json()).service === 'mivo-workflow';
  } catch {
    return false;
  }
}
export async function ensureLocalService() {
  if (await healthy()) return;
  if (starting) return starting;
  starting = (async () => {
    const directory = process.env.MIVO_WORKFLOW_DATA_DIR ?? join(homedir(), '.mivo-workflow');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const log = openSync(join(directory, 'server.log'), 'a', 0o600);
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./index.ts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        detached: true,
        stdio: ['ignore', log, log],
        env: process.env,
      },
    );
    closeSync(log);
    let failed = false;
    child.once('error', () => {
      failed = true;
    });
    child.once('exit', () => {
      failed = true;
    });
    child.unref();
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await healthy()) return;
      if (failed) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('本地工作流服务启动失败，请检查 ' + join(directory, 'server.log'));
  })();
  try {
    await starting;
  } finally {
    starting = undefined;
  }
}

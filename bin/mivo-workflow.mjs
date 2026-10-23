#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(
  process.execPath,
  [
    '--import',
    import.meta.resolve('tsx'),
    fileURLToPath(new URL('../server/cli.ts', import.meta.url)),
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
child.on('error', () => {
  console.error('无法启动工作流命令行');
  process.exitCode = 1;
});

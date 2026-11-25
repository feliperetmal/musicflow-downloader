import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

function launch(name, args) {
  const child = spawn(npmCmd, args, {
    stdio: 'inherit',
    shell: isWindows,
    env: process.env,
  });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[${name}] encerrou com código ${code}`);
    }
  });
  return child;
}

const worker = launch('worker', ['--workspace=@musicflow/worker', 'run', 'dev']);
const web = launch('web', ['--workspace=@musicflow/web', 'run', 'dev']);

function shutdown() {
  worker.kill('SIGTERM');
  web.kill('SIGTERM');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

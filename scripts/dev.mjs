import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function loadRootEnv() {
  const env = { ...process.env };
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (env[key] === undefined) {
        env[key] = val;
      }
    }
  }
  // Force full-stack local BFF mode (clear any static-export/GitHub-Pages build vars)
  delete env.STATIC_EXPORT;
  delete env.NEXT_PUBLIC_STATIC_EXPORT;
  delete env.NEXT_PUBLIC_BASE_PATH;
  delete env.NEXT_PUBLIC_API_URL;
  delete env.NEXT_PUBLIC_WORKER_URL;
  env.WORKER_BASE_URL = env.WORKER_BASE_URL || 'http://127.0.0.1:4000';
  return env;
}

function getLocalLanIps() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const info of entries || []) {
      if (info.family === 'IPv4' && !info.internal) {
        ips.push(info.address);
      }
    }
  }
  return ips;
}

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const env = loadRootEnv();

function launch(name, args) {
  const child = spawn(npmCmd, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: isWindows,
    env,
  });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[${name}] encerrou com código ${code}`);
    }
  });
  return child;
}

const lanIps = getLocalLanIps();
console.log('=======================================================');
console.log(' MusicFlow Downloader — Modo Local & Rede Wi-Fi');
console.log('-------------------------------------------------------');
console.log(' PC (Local):       http://localhost:3000');
for (const ip of lanIps) {
  console.log(` Celular (Wi-Fi):  http://${ip}:3000`);
}
console.log('=======================================================');

const worker = launch('worker', ['--workspace=@musicflow/worker', 'run', 'dev']);
const web = launch('web', ['--workspace=@musicflow/web', 'run', 'dev']);

function shutdown() {
  worker.kill('SIGTERM');
  web.kill('SIGTERM');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

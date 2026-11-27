import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

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

  // Ensure local full-stack mode (not GitHub Pages static export)
  delete env.STATIC_EXPORT;
  delete env.NEXT_PUBLIC_STATIC_EXPORT;
  delete env.NEXT_PUBLIC_BASE_PATH;
  delete env.NEXT_PUBLIC_API_URL;
  delete env.NEXT_PUBLIC_WORKER_URL;
  env.WORKER_BASE_URL = env.WORKER_BASE_URL || 'http://127.0.0.1:4000';
  env.FRONTEND_BASE_URL = env.FRONTEND_BASE_URL || 'http://localhost:3000';
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

async function waitForUrl(url, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

function ensureBuilt(env) {
  const sharedDist = path.join(rootDir, 'packages', 'shared', 'dist', 'index.js');
  const workerDist = path.join(rootDir, 'apps', 'worker', 'dist', 'index.js');
  const webNextDir = path.join(rootDir, 'apps', 'web', '.next');
  const webBuildId = path.join(webNextDir, 'BUILD_ID');
  const webPrerenderManifest = path.join(webNextDir, 'prerender-manifest.json');
  const webExportMarker = path.join(webNextDir, 'export-marker.json');
  const webRoutesManifest = path.join(webNextDir, 'routes-manifest.json');

  if (!fs.existsSync(sharedDist)) {
    console.log('[MusicFlow] Compilando @musicflow/shared...');
    execSync(`${npmCmd} --workspace=@musicflow/shared run build`, { cwd: rootDir, stdio: 'inherit', env });
  }

  if (!fs.existsSync(workerDist)) {
    console.log('[MusicFlow] Compilando @musicflow/worker...');
    execSync(`${npmCmd} --workspace=@musicflow/worker run build`, { cwd: rootDir, stdio: 'inherit', env });
  }

  let needsWebBuild =
    !fs.existsSync(webBuildId) ||
    !fs.existsSync(webPrerenderManifest) ||
    fs.existsSync(webExportMarker);
  if (!needsWebBuild && fs.existsSync(webRoutesManifest)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(webRoutesManifest, 'utf8'));
      if (manifest.basePath) {
        needsWebBuild = true;
      }
    } catch {
      needsWebBuild = true;
    }
  }

  if (needsWebBuild) {
    console.log('[MusicFlow] Compilando interface Web para execução local rápida...');
    if (fs.existsSync(webNextDir)) {
      fs.rmSync(webNextDir, { recursive: true, force: true });
    }
    execSync(`${npmCmd} --workspace=@musicflow/web run build`, {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...env, NODE_ENV: 'production' },
    });
  }
}

function openBrowser(url) {
  if (process.env.NO_BROWSER === '1') return;
  try {
    if (isWindows) {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // ignore browser launch errors
  }
}

async function main() {
  const env = loadRootEnv();
  ensureBuilt(env);

  console.log('[MusicFlow] Iniciando Worker (FFmpeg + yt-dlp + Spotify)...');
  const worker = spawn(process.execPath, [path.join(rootDir, 'apps', 'worker', 'dist', 'index.js')], {
    cwd: rootDir,
    stdio: 'inherit',
    env,
  });

  console.log('[MusicFlow] Iniciando servidor Web em 0.0.0.0:3000...');
  const nextBin = path.join(rootDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const web = spawn(process.execPath, [nextBin, 'start', '-H', '0.0.0.0', '-p', '3000'], {
    cwd: path.join(rootDir, 'apps', 'web'),
    stdio: 'inherit',
    env: { ...env, NODE_ENV: 'production' },
  });

  const shutdown = () => {
    worker.kill('SIGTERM');
    web.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const [workerOk, webOk] = await Promise.all([
    waitForUrl('http://127.0.0.1:4000/ready'),
    waitForUrl('http://127.0.0.1:3000'),
  ]);

  const lanIps = getLocalLanIps();
  console.log('');
  console.log('===============================================================');
  console.log('  MUSICFLOW DOWNLOADER ONLINE LOCALMENTE');
  console.log('---------------------------------------------------------------');
  console.log(`  Status Worker: ${workerOk ? 'OK (Porta 4000)' : 'Iniciando...'}`);
  console.log(`  Status Web:    ${webOk ? 'OK (Porta 3000)' : 'Iniciando...'}`);
  console.log('');
  console.log('  No seu computador:       http://localhost:3000');
  for (const ip of lanIps) {
    console.log(`  No celular (mesmo Wi-Fi): http://${ip}:3000`);
  }
  console.log('');
  console.log('  Obs.: Para acessar pelo celular, mantenha esta janela aberta.');
  console.log('        Para encerrar, pressione Ctrl+C ou feche esta janela.');
  console.log('===============================================================');
  console.log('');

  if (webOk) {
    openBrowser('http://localhost:3000');
  }
}

main().catch((err) => {
  console.error('[MusicFlow] Erro ao iniciar localmente:', err);
  process.exit(1);
});

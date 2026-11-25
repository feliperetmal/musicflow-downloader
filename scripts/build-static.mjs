import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const apiDir = path.join(rootDir, 'apps', 'web', 'src', 'app', 'api');
const tempApiDir = path.join(rootDir, 'apps', 'web', 'src', 'app', '_api_build_tmp');
const outDir = path.join(rootDir, 'apps', 'web', 'out');

console.log('[build-static] Iniciando compilação estática do MusicFlow Web para GitHub Pages...');

let moved = false;
try {
  if (fs.existsSync(apiDir)) {
    console.log('[build-static] Isolando rotas dinâmicas do Node.js durante export estático...');
    fs.renameSync(apiDir, tempApiDir);
    moved = true;
  }

  process.env.STATIC_EXPORT = 'true';
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('[build-static] Executando next build (output: export)...');
  execSync(`${npmCmd} --workspace=@musicflow/web run build`, {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, STATIC_EXPORT: 'true' },
  });

  // Create .nojekyll in out directory so GitHub Pages serves _next assets properly
  if (fs.existsSync(outDir)) {
    fs.writeFileSync(path.join(outDir, '.nojekyll'), '', 'utf8');
    console.log('[build-static] Arquivo .nojekyll gerado com sucesso em apps/web/out/.nojekyll');
  }

  console.log('[build-static] Build estático para GitHub Pages concluído com sucesso!');
} catch (err) {
  console.error('[build-static] Falha na compilação estática:', err);
  process.exitCode = 1;
} finally {
  if (moved && fs.existsSync(tempApiDir)) {
    try {
      fs.renameSync(tempApiDir, apiDir);
      console.log('[build-static] Rotas do Next.js App Router restauradas com segurança.');
    } catch (restoreErr) {
      console.error('[build-static] Erro ao restaurar rotas da API:', restoreErr);
    }
  }
}

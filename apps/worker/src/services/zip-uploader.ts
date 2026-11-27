import fsSync, { openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import archiver from 'archiver';
import { log } from '../logger.js';
import { safeFetch } from '../security/ssrf.js';

const ANON_UPLOAD_ALLOWED_HOSTS = new Set(['catbox.moe', 'litterbox.catbox.moe']);
const CATBOX_MAX_BYTES = 200 * 1024 * 1024;
const LITTERBOX_MAX_BYTES = 1024 * 1024 * 1024;

export type AnonymousZipProvider = 'auto' | 'catbox' | 'litterbox';
export type LitterboxRetention = '1h' | '12h' | '24h' | '72h';

export interface AnonymousZipUploadResult {
  url: string;
  provider: 'catbox' | 'litterbox';
  fileName: string;
  sizeBytes: number;
  expiresIn: string;
}

export async function writeZipArchiveToDisk(
  files: Array<{ filePath: string; filename: string }>,
  destPath: string,
): Promise<{ sizeBytes: number }> {
  await new Promise<void>((resolve, reject) => {
    const output = fsSync.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 1 } });

    output.on('close', () => resolve());
    output.on('error', (err) => reject(err));
    archive.on('error', (err) => reject(err));

    archive.pipe(output);
    for (const f of files) {
      archive.file(f.filePath, { name: f.filename });
    }
    void archive.finalize();
  });

  const stat = await fs.stat(destPath);
  return { sizeBytes: stat.size };
}

function validateHostedZipUrl(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('https://')) return null;
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.hostname === 'files.catbox.moe' ||
      parsed.hostname === 'litter.catbox.moe' ||
      parsed.hostname.endsWith('.catbox.moe')
    ) {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

async function postMultipartToHost(options: {
  endpoint: string;
  filePath: string;
  fileName: string;
  extraFields: Record<string, string>;
  allowPrivateNetworkFetch: boolean;
}): Promise<string> {
  const blob = await openAsBlob(options.filePath, { type: 'application/zip' });
  const form = new FormData();
  form.set('reqtype', 'fileupload');
  for (const [k, v] of Object.entries(options.extraFields)) {
    form.set(k, v);
  }
  form.set('fileToUpload', blob, options.fileName);

  const res = await safeFetch(options.endpoint, {
    method: 'POST',
    body: form,
    allowedHosts: ANON_UPLOAD_ALLOWED_HOSTS,
    allowPrivateNetworkFetch: options.allowPrivateNetworkFetch,
    timeoutMs: 180_000,
  });

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Servidor de upload retornou HTTP ${res.status}.`);
  }

  const hostedUrl = validateHostedZipUrl(bodyText);
  if (!hostedUrl) {
    throw new Error(`Resposta inesperada do servidor de upload: ${bodyText.slice(0, 120)}`);
  }
  return hostedUrl;
}

export async function uploadZipToAnonymousHost(options: {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  provider?: AnonymousZipProvider;
  retention?: LitterboxRetention;
  allowPrivateNetworkFetch: boolean;
}): Promise<AnonymousZipUploadResult> {
  const provider = options.provider ?? 'auto';
  const retention = options.retention ?? '72h';

  if (options.sizeBytes > LITTERBOX_MAX_BYTES) {
    throw new Error('O arquivo ZIP excede o limite de 1 GB para hospedagem anônima sem login.');
  }

  const canUseCatbox =
    (provider === 'catbox' || provider === 'auto') && options.sizeBytes <= CATBOX_MAX_BYTES;

  if (provider === 'catbox' && options.sizeBytes > CATBOX_MAX_BYTES) {
    throw new Error('O Catbox.moe aceita no máximo 200 MB por arquivo. Use o Litterbox (até 1 GB).');
  }

  if (canUseCatbox) {
    try {
      const url = await postMultipartToHost({
        endpoint: 'https://catbox.moe/user/api.php',
        filePath: options.filePath,
        fileName: options.fileName,
        extraFields: {},
        allowPrivateNetworkFetch: options.allowPrivateNetworkFetch,
      });
      log('info', 'ZIP enviado ao Catbox.moe com sucesso', {
        fileName: options.fileName,
        sizeBytes: options.sizeBytes,
        url,
      });
      return {
        url,
        provider: 'catbox',
        fileName: options.fileName,
        sizeBytes: options.sizeBytes,
        expiresIn: 'Permanente (Catbox.moe)',
      };
    } catch (err) {
      if (provider === 'catbox') {
        throw err;
      }
      log('warn', 'Falha no Catbox.moe; tentando fallback para Litterbox', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const url = await postMultipartToHost({
    endpoint: 'https://litterbox.catbox.moe/resources/internals/api.php',
    filePath: options.filePath,
    fileName: options.fileName,
    extraFields: { time: retention },
    allowPrivateNetworkFetch: options.allowPrivateNetworkFetch,
  });

  log('info', 'ZIP enviado ao Litterbox (Catbox) com sucesso', {
    fileName: options.fileName,
    sizeBytes: options.sizeBytes,
    retention,
    url,
  });

  return {
    url,
    provider: 'litterbox',
    fileName: options.fileName,
    sizeBytes: options.sizeBytes,
    expiresIn: `Temporário (${retention} — Litterbox)`,
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkerConfig } from '../config.js';
import { log } from '../logger.js';

export interface TempDirectories {
  root: string;
  uploads: string;
  outputs: string;
  scratch: string;
}

export function getTempDirectories(config: WorkerConfig): TempDirectories {
  return {
    root: config.tempDir,
    uploads: path.join(config.tempDir, 'uploads'),
    outputs: path.join(config.tempDir, 'outputs'),
    scratch: path.join(config.tempDir, 'scratch'),
  };
}

export async function ensureTempDirectories(config: WorkerConfig): Promise<TempDirectories> {
  const dirs = getTempDirectories(config);
  await Promise.all([
    fs.mkdir(dirs.uploads, { recursive: true }),
    fs.mkdir(dirs.outputs, { recursive: true }),
    fs.mkdir(dirs.scratch, { recursive: true }),
  ]);
  return dirs;
}

export async function safeUnlink(targetPath?: string): Promise<void> {
  if (!targetPath) return;
  try {
    await fs.unlink(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('warn', 'Falha ao remover arquivo temporário', { targetPath, error: (err as Error).message });
    }
  }
}

export async function cleanupExpiredFiles(
  dirPath: string,
  maxAgeMs: number,
  onDelete?: (filename: string) => void,
): Promise<number> {
  let deleted = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return 0;
  }

  const now = Date.now();
  for (const name of entries) {
    const fullPath = path.join(dirPath, name);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
        await fs.unlink(fullPath);
        deleted++;
        onDelete?.(name);
      }
    } catch {
      // Ignore concurrent deletion
    }
  }
  return deleted;
}

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function createWorkerAuthMiddleware(expectedSecret: string, allowedOrigins: string[] = []) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!expectedSecret) {
      next();
      return;
    }

    // Spotify user OAuth endpoints are public by nature
    const fullPath = (req.originalUrl || req.url || '').split('?')[0];
    if (fullPath.startsWith('/auth/spotify')) {
      next();
      return;
    }

    const headerSecret =
      req.header('x-worker-secret') ||
      (req.header('authorization')?.startsWith('Bearer ')
        ? req.header('authorization')!.slice(7)
        : '');

    if (headerSecret) {
      const expectedBuf = Buffer.from(expectedSecret, 'utf8');
      const actualBuf = Buffer.from(headerSecret, 'utf8');
      if (
        expectedBuf.length === actualBuf.length &&
        crypto.timingSafeEqual(expectedBuf, actualBuf)
      ) {
        next();
        return;
      }
      res.status(403).json({ error: 'Credencial de worker inválida.' });
      return;
    }

    // Allow direct requests from verified web origins (GitHub Pages or local dev)
    const origin = req.header('origin');
    if (
      origin &&
      (allowedOrigins.includes('*') ||
        allowedOrigins.includes(origin) ||
        origin.endsWith('.github.io') ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:'))
    ) {
      next();
      return;
    }

    res.status(401).json({ error: 'Autenticação do worker ausente.' });
  };
}

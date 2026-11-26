import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface RequestAuthContext {
  ownerId: string;
  isAdminProxy: boolean;
  expiresAtMs?: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: RequestAuthContext;
  }
}

interface SignedPayload {
  typ: 'session' | 'download';
  sub: string;
  res?: string;
  kind?: 'job' | 'zip';
  iat: number;
  exp: number;
}

function timingSafeMatch(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function signPayload(secret: string, payload: SignedPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySignedToken(secret: string, token: string): SignedPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, providedSig] = parts;
  if (!encoded || !providedSig) return null;

  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!timingSafeMatch(expectedSig, providedSig)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedPayload;
    if (!parsed || typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number') {
      return null;
    }
    if (Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function issueClientToken(
  sessionSecret: string,
  ownerId: string,
  ttlSeconds = 7200,
): { token: string; expiresAt: string; ownerId: string } {
  const now = Date.now();
  const exp = now + ttlSeconds * 1000;
  const token = signPayload(sessionSecret, {
    typ: 'session',
    sub: ownerId,
    iat: now,
    exp,
  });
  return {
    token,
    expiresAt: new Date(exp).toISOString(),
    ownerId,
  };
}

export function verifyClientToken(
  sessionSecret: string,
  token: string,
): { ownerId: string; exp: number } | null {
  const payload = verifySignedToken(sessionSecret, token);
  if (!payload || payload.typ !== 'session') return null;
  return { ownerId: payload.sub, exp: payload.exp };
}

export function issueDownloadTicket(
  sessionSecret: string,
  params: { ownerId: string; resourceId: string; kind: 'job' | 'zip'; ttlSeconds?: number },
): string {
  const now = Date.now();
  const exp = now + (params.ttlSeconds ?? 1800) * 1000;
  return signPayload(sessionSecret, {
    typ: 'download',
    sub: params.ownerId,
    res: params.resourceId,
    kind: params.kind,
    iat: now,
    exp,
  });
}

export function verifyDownloadTicket(
  sessionSecret: string,
  ticket: string,
  expectedKind: 'job' | 'zip',
  expectedResourceId: string,
): { ownerId: string } | null {
  const payload = verifySignedToken(sessionSecret, ticket);
  if (
    !payload ||
    payload.typ !== 'download' ||
    payload.kind !== expectedKind ||
    payload.res !== expectedResourceId
  ) {
    return null;
  }
  return { ownerId: payload.sub };
}

export interface WorkerAuthMiddlewareOptions {
  workerApiSecret: string;
  sessionSecret: string;
  nodeEnv: string;
}

/**
 * Authenticates requests via either:
 * 1. Server-to-server `x-worker-secret` (Next.js BFF proxy / internal tests)
 * 2. Individual HMAC-signed client session Bearer tokens (`Authorization: Bearer ...`)
 * 3. Scoped short-lived HMAC download tickets on `/download` routes (`?ticket=...`)
 *
 * NEVER trusts Origin headers or `.github.io` hostnames as proof of authentication.
 */
export function createWorkerAuthMiddleware(options: WorkerAuthMiddlewareOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const fullPath = (req.originalUrl || req.url || '').split('?')[0];

    // 1. Check server-to-server worker secret header (only used by backend BFF, never browser)
    const workerSecretHeader = req.header('x-worker-secret');
    if (workerSecretHeader) {
      if (!options.workerApiSecret || !timingSafeMatch(options.workerApiSecret, workerSecretHeader)) {
        res.status(403).json({ error: 'Credencial de worker inválida.' });
        return;
      }
      const forwardedOwner = req.header('x-client-owner')?.trim();
      req.auth = {
        ownerId: forwardedOwner || 'bff-default',
        isAdminProxy: !forwardedOwner,
      };
      next();
      return;
    }

    // 2. Check individual client session Bearer token
    const authHeader = req.header('authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const verified = verifyClientToken(options.sessionSecret, token);
      if (verified) {
        req.auth = {
          ownerId: verified.ownerId,
          isAdminProxy: false,
          expiresAtMs: verified.exp,
        };
        next();
        return;
      }
      res.status(401).json({ error: 'Sessão expirada ou inválida. Atualizando credencial...' });
      return;
    }

    // 3. Check short-lived scoped download ticket for direct browser <a download> links (iOS Safari)
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (ticket && fullPath.endsWith('/download')) {
      const isZipDownload = fullPath === '/jobs/zip/download';
      const jobMatch = /^\/jobs\/([^/]+)\/download$/.exec(fullPath);
      if (isZipDownload) {
        const zipId = typeof req.query.zipId === 'string' && req.query.zipId ? req.query.zipId : 'batch-zip';
        const verifiedZip = verifyDownloadTicket(options.sessionSecret, ticket, 'zip', zipId);
        if (verifiedZip) {
          req.auth = { ownerId: verifiedZip.ownerId, isAdminProxy: false };
          next();
          return;
        }
      } else if (jobMatch?.[1]) {
        const verifiedJob = verifyDownloadTicket(options.sessionSecret, ticket, 'job', decodeURIComponent(jobMatch[1]));
        if (verifiedJob) {
          req.auth = { ownerId: verifiedJob.ownerId, isAdminProxy: false };
          next();
          return;
        }
      }
      res.status(401).json({ error: 'Link de download expirado ou inválido.' });
      return;
    }

    // 4. Local dev/test fallback ONLY when no workerApiSecret is set outside production
    if (!options.workerApiSecret && options.nodeEnv !== 'production') {
      req.auth = { ownerId: 'dev-local', isAdminProxy: true };
      next();
      return;
    }

    res.status(401).json({ error: 'Autenticação necessária.' });
  };
}

export function createAdminDiagnosticsMiddleware(adminSecret: string, nodeEnv: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!adminSecret) {
      if (nodeEnv === 'production') {
        res.status(403).json({ error: 'Painel de diagnóstico administrativo desabilitado em produção.' });
        return;
      }
      next();
      return;
    }

    const provided = req.header('x-admin-secret') || '';
    if (!provided || !timingSafeMatch(adminSecret, provided)) {
      res.status(401).json({ error: 'Chave administrativa necessária para acessar diagnósticos.' });
      return;
    }
    next();
  };
}

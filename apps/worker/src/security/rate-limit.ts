import type { NextFunction, Request, Response } from 'express';

interface BucketEntry {
  timestamps: number[];
}

export function createRateLimiter(options: { windowMs: number; maxRequests: number }) {
  const hits = new Map<string, BucketEntry>();

  // Periodic cleanup of stale IP entries
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - options.windowMs;
    for (const [ip, entry] of hits.entries()) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) {
        hits.delete(ip);
      }
    }
  }, Math.max(options.windowMs, 30_000));
  cleanupTimer.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - options.windowMs;

    const entry = hits.get(key) ?? { timestamps: [] };
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= options.maxRequests) {
      const oldest = entry.timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.status(429).json({
        error: 'Muitas requisições em pouco tempo. Aguarde alguns segundos e tente novamente.',
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    entry.timestamps.push(now);
    hits.set(key, entry);
    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, options.maxRequests - entry.timestamps.length)));
    next();
  };
}

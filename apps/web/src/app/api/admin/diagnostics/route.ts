import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { proxyToWorker } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const expectedSecret = process.env.ADMIN_DIAGNOSTICS_SECRET;
  if (expectedSecret) {
    const provided =
      req.headers.get('x-admin-secret') ||
      req.nextUrl.searchParams.get('secret') ||
      '';
    const expectedBuf = Buffer.from(expectedSecret, 'utf8');
    const actualBuf = Buffer.from(provided, 'utf8');
    if (
      expectedBuf.length !== actualBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, actualBuf)
    ) {
      return NextResponse.json(
        { error: 'Acesso restrito ao painel de diagnóstico. Informe a chave administrativa.' },
        { status: 401 },
      );
    }
  }

  try {
    const forwardHeaders: Record<string, string> = {};
    const adminHeader = req.headers.get('x-admin-secret') || process.env.ADMIN_DIAGNOSTICS_SECRET;
    if (adminHeader) {
      forwardHeaders['x-admin-secret'] = adminHeader;
    }
    const res = await proxyToWorker('/diagnostics', { headers: forwardHeaders });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Worker de diagnóstico indisponível.' }, { status: 502 });
  }
}

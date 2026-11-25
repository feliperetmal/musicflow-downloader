import { NextRequest, NextResponse } from 'next/server';
import { proxyToWorker } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const returnTo = req.nextUrl.searchParams.get('returnTo') || '/';
    const res = await proxyToWorker(`/auth/spotify/login?returnTo=${encodeURIComponent(returnTo)}`);
    const data = await res.json();
    if (!res.ok || !data.authorizeUrl) {
      return NextResponse.redirect(
        new URL(`/?spotifyError=${encodeURIComponent(data.error || 'Spotify não configurado.')}`, req.url),
      );
    }
    return NextResponse.redirect(data.authorizeUrl);
  } catch {
    return NextResponse.redirect(
      new URL('/?spotifyError=Serviço+de+autenticação+indisponível', req.url),
    );
  }
}

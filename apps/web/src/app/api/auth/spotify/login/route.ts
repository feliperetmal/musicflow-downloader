import { NextRequest, NextResponse } from 'next/server';
import { proxyToWorker } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const wantsJson =
    req.headers.get('sec-fetch-mode') === 'cors' ||
    req.headers.get('sec-fetch-dest') === 'empty' ||
    (req.headers.get('accept') || '').includes('application/json');

  try {
    const returnTo = req.nextUrl.searchParams.get('returnTo') || '/';
    const frontendUrl = req.nextUrl.searchParams.get('frontendUrl') || '';
    const qs = new URLSearchParams({ returnTo });
    if (frontendUrl) qs.set('frontendUrl', frontendUrl);

    const res = await proxyToWorker(`/auth/spotify/login?${qs.toString()}`);
    const data = await res.json();
    if (!res.ok || !data.authorizeUrl) {
      if (wantsJson) {
        return NextResponse.json(
          { error: data.error || 'Spotify não configurado.' },
          { status: res.status || 500 },
        );
      }
      return NextResponse.redirect(
        new URL(`/?spotifyError=${encodeURIComponent(data.error || 'Spotify não configurado.')}`, req.url),
      );
    }
    if (wantsJson) {
      return NextResponse.json({ authorizeUrl: data.authorizeUrl });
    }
    return NextResponse.redirect(data.authorizeUrl);
  } catch {
    if (wantsJson) {
      return NextResponse.json(
        { error: 'Serviço de autenticação temporariamente indisponível.' },
        { status: 502 },
      );
    }
    return NextResponse.redirect(
      new URL('/?spotifyError=Serviço+de+autenticação+indisponível', req.url),
    );
  }
}

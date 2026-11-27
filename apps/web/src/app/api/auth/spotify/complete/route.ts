import { NextRequest, NextResponse } from 'next/server';
import { proxyToWorker, SPOTIFY_SESSION_COOKIE } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const handoff = req.nextUrl.searchParams.get('handoff') || '';
  const returnToParam = req.nextUrl.searchParams.get('returnTo') || '/';
  const safeReturnTo =
    returnToParam.startsWith('/') && !returnToParam.startsWith('//') ? returnToParam : '/';

  try {
    const res = await proxyToWorker('/auth/spotify/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handoff }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Sessão inválida.' }));
      return NextResponse.redirect(
        new URL(`/?spotifyError=${encodeURIComponent(err.error || 'Falha no login Spotify.')}`, req.url),
      );
    }

    const data = (await res.json()) as { sessionId: string; returnTo?: string };
    const finalPath =
      data.returnTo && data.returnTo.startsWith('/') && !data.returnTo.startsWith('//')
        ? data.returnTo
        : safeReturnTo;

    const isHttps =
      req.nextUrl.protocol === 'https:' ||
      req.headers.get('x-forwarded-proto') === 'https';

    const response = NextResponse.redirect(new URL(finalPath, req.url));
    response.cookies.set(SPOTIFY_SESSION_COOKIE, data.sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: isHttps,
      maxAge: 60 * 60 * 24 * 180, // 180 days (6 months persistent Spotify session)
    });
    return response;
  } catch {
    return NextResponse.redirect(
      new URL('/?spotifyError=Erro+ao+finalizar+login+Spotify', req.url),
    );
  }
}

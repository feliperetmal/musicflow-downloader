import { NextResponse } from 'next/server';
import { proxyToWorker, SPOTIFY_SESSION_COOKIE } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function POST() {
  try {
    await proxyToWorker('/auth/spotify/logout', { method: 'POST' });
  } catch {
    // Clear cookie even if worker unreachable
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SPOTIFY_SESSION_COOKIE);
  return res;
}

import { NextResponse } from 'next/server';
import { proxyToWorker } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const res = await proxyToWorker('/auth/spotify/status');
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      {
        authenticated: false,
        clientConfigured: false,
        hasClientSecret: false,
        developmentMode: true,
        redirectUri: 'http://127.0.0.1:8888/callback',
        scopes: [],
        tokenValid: false,
      },
      { status: 503 },
    );
  }
}

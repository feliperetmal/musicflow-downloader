import { NextRequest, NextResponse } from 'next/server';
import { proxyToWorker } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const urlParam = req.nextUrl.searchParams.get('url') || '';
  try {
    const res = await proxyToWorker(`/analyze/stream?url=${encodeURIComponent(urlParam)}`);
    return new NextResponse(res.body, {
      status: res.status,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Falha ao iniciar análise em fluxo.' }, { status: 502 });
  }
}

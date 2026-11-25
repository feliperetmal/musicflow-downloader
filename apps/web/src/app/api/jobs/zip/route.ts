import { NextRequest, NextResponse } from 'next/server';
import { proxyToWorker } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const res = await proxyToWorker('/jobs/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const headers = new Headers();
    for (const h of ['content-type', 'content-disposition']) {
      const val = res.headers.get(h);
      if (val) headers.set(h, val);
    }
    return new NextResponse(res.body, { status: res.status, headers });
  } catch {
    return NextResponse.json({ error: 'Falha ao gerar arquivo ZIP.' }, { status: 502 });
  }
}

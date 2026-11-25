import { NextRequest, NextResponse } from 'next/server';
import { proxyToWorker } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const range = req.headers.get('range');
    const res = await proxyToWorker(`/uploads/${encodeURIComponent(id)}/preview`, {
      headers: range ? { range } : {},
    });
    const headers = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const val = res.headers.get(h);
      if (val) headers.set(h, val);
    }
    return new NextResponse(res.body, { status: res.status, headers });
  } catch {
    return NextResponse.json({ error: 'Pré-visualização indisponível.' }, { status: 502 });
  }
}

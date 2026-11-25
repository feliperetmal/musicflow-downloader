import { NextRequest, NextResponse } from 'next/server';
import { proxyToWorker } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const res = await proxyToWorker(`/jobs/${encodeURIComponent(id)}/download`);
    const headers = new Headers();
    for (const h of ['content-type', 'content-length', 'content-disposition']) {
      const val = res.headers.get(h);
      if (val) headers.set(h, val);
    }
    return new NextResponse(res.body, { status: res.status, headers });
  } catch {
    return NextResponse.json({ error: 'Falha ao baixar arquivo MP3.' }, { status: 502 });
  }
}

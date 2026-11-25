import { NextResponse } from 'next/server';
import { proxyToWorker } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const res = await proxyToWorker('/health');
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      {
        status: 'offline',
        error: 'Worker de processamento FFmpeg indisponível no momento.',
      },
      { status: 503 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { proxyToWorker } from '@/lib/worker-client';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const res = await proxyToWorker('/uploads', {
      method: 'POST',
      body: formData,
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
    });
  } catch {
    return NextResponse.json(
      { error: 'Falha ao enviar arquivo para o servidor de conversão.' },
      { status: 502 },
    );
  }
}

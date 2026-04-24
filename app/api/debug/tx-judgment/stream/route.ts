import { readTxJudgmentStoreVersion } from '@/lib/txJudgmentStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();
const POLL_INTERVAL_MS = 1500;

function toSseFrame(payload: object) {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(request: Request) {
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let lastVersion = await readTxJudgmentStoreVersion();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(toSseFrame({ type: 'hello', version: lastVersion }));

      const tick = async () => {
        if (closed) {
          return;
        }
        const nextVersion = await readTxJudgmentStoreVersion();
        if (nextVersion !== lastVersion) {
          lastVersion = nextVersion;
          controller.enqueue(toSseFrame({ type: 'updated', version: nextVersion }));
          return;
        }
        controller.enqueue(toSseFrame({ type: 'ping', version: lastVersion }));
      };

      timer = setInterval(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  });

  request.signal.addEventListener('abort', () => {
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}


import { abortError, asGatewayError } from './errors.mjs';

// Progress snapshots may replace each other while a browser is slow. A final
// result always flushes the latest snapshot before ending the stream.
export async function streamEvents(response, signal, run) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  response.flushHeaders();
  let latest;
  const send = (event, data) => {
    if (response.destroyed || response.writableEnded) return;
    // Disconnect a stalled consumer; resumable jobs continue independently.
    if (response.writableLength > 2 * 1024 * 1024) {
      response.destroy();
      return;
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const flush = () => {
    if (!latest) return;
    send('progress', latest);
    latest = undefined;
  };
  const updates = setInterval(flush, 100);
  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
  }, 15_000);
  updates.unref?.();
  heartbeat.unref?.();
  try {
    const result = await run(progress => { latest = progress; });
    flush();
    send('result', result);
  } catch (error) {
    const failure = asGatewayError(error);
    send('error', { code: failure.code, message: failure.message, status: failure.statusCode });
  } finally {
    clearInterval(updates);
    clearInterval(heartbeat);
    response.end();
  }
}

export function watchJob(jobs, id, signal, onProgress) {
  let unsubscribe;
  let onAbort;
  return new Promise((resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else {
      try {
        unsubscribe = jobs.subscribe(id, job => {
          if (job.status === 'completed') resolve(job);
          else if (job.status === 'failed') reject({ ...job.error, statusCode: job.error?.status || 502 });
          else onProgress(job.progress);
        });
      } catch (error) { reject(error); }
    }
  }).finally(() => {
    unsubscribe?.();
    signal.removeEventListener('abort', onAbort);
  });
}

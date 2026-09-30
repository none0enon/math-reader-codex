import { createHash } from 'node:crypto';
import { GatewayError, asGatewayError } from './errors.mjs';
import { validateAskBody } from './request.mjs';

const DEFAULT_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const RESULT_RETENTION_MS = 30 * 60 * 1000;

// Lecture jobs outlive individual HTTP requests. Only the job deadline, not a
// browser disconnect while polling, cancels inference. The deadline starts when
// the job leaves the inference queue, so a chapter waiting behind another
// lecture keeps its full generation time. The registry is private to this
// gateway process and all access still requires its bearer token.
export class LectureJobs {
  constructor(engine, maxPending, { timeoutMs = DEFAULT_JOB_TIMEOUT_MS } = {}) {
    this.engine = engine;
    this.maxActive = maxPending + 1;
    this.timeoutMs = timeoutMs;
    this.jobs = new Map();
  }

  prune() {
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && Date.now() - job.finishedAt > RESULT_RETENTION_MS) {
        this.jobs.delete(id);
      }
    }
  }

  read(id) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw new GatewayError('job_not_found', 'The lecture job expired or the gateway restarted.', 404);
    return {
      id,
      status: job.status,
      ...(job.status === 'pending' ? {
        progress: { ...job.progress, elapsedMs: Date.now() - job.createdAt },
      } : {}),
      ...(job.result || {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  create(body) {
    if (!body || typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.id)) {
      throw new GatewayError('invalid_request', 'A lecture job requires a UUID id.', 400);
    }
    validateAskBody(body.request);
    const fingerprint = createHash('sha256').update(JSON.stringify(body.request)).digest('hex');
    this.prune();
    const existing = this.jobs.get(body.id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new GatewayError('job_conflict', 'This lecture job id belongs to another request.', 409);
      }
      return this.read(body.id);
    }
    const active = [...this.jobs.values()].filter(job => !job.finishedAt).length;
    if (active >= this.maxActive || this.jobs.size >= 64) {
      throw new GatewayError('queue_full', 'The private Codex gateway lecture queue is full.', 503);
    }
    const controller = new AbortController();
    const job = {
      status: 'pending', fingerprint, finishedAt: null, createdAt: Date.now(),
      progress: { stage: 'queued', partialText: '', reasoningSummary: '' },
    };
    this.jobs.set(body.id, job);
    const minutes = Math.max(1, Math.round(this.timeoutMs / 60_000));
    let timer;
    const startDeadline = () => {
      if (timer) return;
      timer = setTimeout(() => controller.abort(
        new GatewayError('request_timeout', `Lecture generation exceeded ${minutes} minutes; use a smaller section or lower reasoning effort.`, 504),
      ), this.timeoutMs);
      timer.unref?.();
    };
    // Validation above is synchronous. The remaining work is deliberately not
    // awaited by the HTTP handler, including time spent in the inference queue.
    Promise.resolve().then(() => this.engine.ask(body.request, {
      signal: controller.signal,
      onStart: startDeadline,
      onProgress: progress => { job.progress = progress; },
    }))
      .then(result => {
        job.result = result;
        job.status = 'completed';
      }, error => {
        const failure = asGatewayError(error);
        job.error = { code: failure.code, message: failure.message };
        job.status = 'failed';
      })
      .finally(() => {
        clearTimeout(timer);
        delete job.progress;
        job.finishedAt = Date.now();
      });
    return this.read(body.id);
  }
}

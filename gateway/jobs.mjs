import { createHash } from 'node:crypto';
import { GatewayError, asGatewayError } from './errors.mjs';
import { validateAskBody } from './request.mjs';

const DEFAULT_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const RESULT_RETENTION_MS = 30 * 60 * 1000;

// Lecture jobs outlive their event streams. Each job starts immediately and
// keeps its result available for reconnecting clients with the same job id.
export class LectureJobs {
  constructor(engine, { timeoutMs = DEFAULT_JOB_TIMEOUT_MS } = {}) {
    this.engine = engine;
    this.timeoutMs = timeoutMs;
    this.jobs = new Map();
  }

  subscribe(id, listener) {
    this.read(id);
    const job = this.jobs.get(id);
    job.listeners.add(listener);
    listener(this.read(id));
    return () => job.listeners.delete(listener);
  }

  publish(id) {
    const job = this.jobs.get(id);
    const snapshot = this.read(id);
    for (const listener of job.listeners) listener(snapshot);
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
    // Retention limits evict completed results only and never gate inference.
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < 64) break;
      if (job.finishedAt && !job.listeners.size) this.jobs.delete(id);
    }
    const controller = new AbortController();
    const job = {
      status: 'pending', fingerprint, finishedAt: null, createdAt: Date.now(),
      progress: { stage: 'preparing', partialText: '', reasoningSummary: '' },
      listeners: new Set(),
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
    // The HTTP submission returns immediately while inference runs independently.
    Promise.resolve().then(() => this.engine.ask(body.request, {
      signal: controller.signal,
      lecture: true,
      onStart: startDeadline,
      onProgress: progress => { job.progress = progress; this.publish(body.id); },
    }))
      .then(result => {
        job.result = result;
        job.status = 'completed';
      }, error => {
        const failure = asGatewayError(error);
        job.error = { code: failure.code, message: failure.message, status: failure.statusCode };
        job.status = 'failed';
      })
      .finally(() => {
        clearTimeout(timer);
        delete job.progress;
        job.finishedAt = Date.now();
        this.publish(body.id);
      });
    return this.read(body.id);
  }
}

import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';

import { CodexAppServer } from './app-server.mjs';
import {
  ensureRuntimeState,
  isAllowedOrigin,
  loadConfig,
  readTlsOptions,
} from './config.mjs';
import { GatewayEngine } from './engine.mjs';
import { LectureJobs } from './jobs.mjs';
import { GatewayError, abortError, asGatewayError } from './errors.mjs';

function sendJson(response, statusCode, body, extraHeaders = {}) {
  if (response.destroyed || response.writableEnded) return;
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': String(encoded.length),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(encoded);
}

function tokenMatches(header, expectedToken) {
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const received = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJsonBody(request, maximumBytes, signal) {
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim();
  if (contentType !== 'application/json') {
    throw new GatewayError('unsupported_media_type', 'Content-Type must be application/json.', 415);
  }
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      throw new GatewayError('invalid_request', 'Content-Length is invalid.', 400);
    }
    if (BigInt(contentLength) > BigInt(maximumBytes)) {
      throw new GatewayError('request_too_large', 'The JSON request body is too large.', 413);
    }
  }
  if (signal?.aborted) throw abortError(signal);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const cleanup = () => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
      signal?.removeEventListener('abort', onSignalAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Stop accepting a slow or oversized upload. The handler sends a final
      // response with Connection: close, so the socket is not held open while
      // an untrusted client continues streaming a body.
      request.pause();
      reject(error);
    };
    const onData = (chunk) => {
      length += chunk.length;
      if (length > maximumBytes) {
        fail(new GatewayError('request_too_large', 'The JSON request body is too large.', 413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (length === 0) {
        reject(new GatewayError('invalid_json', 'A JSON request body is required.', 400));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks, length).toString('utf8')));
      } catch {
        reject(new GatewayError('invalid_json', 'The request body is not valid JSON.', 400));
      }
    };
    const onError = (error) => {
      fail(
        signal?.aborted
          ? abortError(signal)
          : new GatewayError('invalid_request', 'The request body could not be read.', 400, {
              cause: error,
            }),
      );
    };
    const onAborted = () => {
      fail(
        signal?.aborted
          ? abortError(signal)
          : new GatewayError('client_disconnected', 'The client disconnected.', 499),
      );
    };
    const onSignalAbort = () => fail(abortError(signal));

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
    signal?.addEventListener('abort', onSignalAbort, { once: true });
    if (signal?.aborted) onSignalAbort();
    else request.resume();
  });
}

function applyCors(request, response, config) {
  const origin = request.headers.origin;
  if (!isAllowedOrigin(origin, config.allowedOrigins)) {
    throw new GatewayError('origin_not_allowed', 'This browser origin is not allowed.', 403);
  }
  response.setHeader('Vary', 'Origin');
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Max-Age', '600');
}

function requestSignal(request, response, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new GatewayError('request_timeout', 'The request timed out.', 504));
  }, timeoutMs);
  timeout.unref?.();
  const disconnected = () => {
    if (!response.writableEnded && !controller.signal.aborted) {
      controller.abort(new GatewayError('client_disconnected', 'The client disconnected.', 499));
    }
  };
  request.once('aborted', disconnected);
  response.once('close', disconnected);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      request.removeListener('aborted', disconnected);
      response.removeListener('close', disconnected);
    },
  };
}

export function createGatewayHandler({ config, engine, token }) {
  const lectureJobs = new LectureJobs(engine, config.maxQueueDepth);
  return async function gatewayHandler(request, response) {
    let cancellation;
    try {
      applyCors(request, response, config);
      const url = new URL(request.url || '/', 'http://gateway.invalid');
      const jobMatch = /^\/v1\/lecture-jobs\/([a-f0-9-]{36})$/i.exec(url.pathname);
      if (request.method === 'OPTIONS') {
        if (!['/v1/ask', '/v1/models', '/v1/status', '/v1/lecture-jobs'].includes(url.pathname) && !jobMatch) {
          throw new GatewayError('not_found', 'Endpoint not found.', 404);
        }
        // Compatibility with browsers using PNA preflights. Modern browsers
        // may additionally require the user's local-network permission.
        // applyCors already validated the origin; actual requests still need
        // the gateway bearer token. Never grant this to origin-less probes.
        if (request.headers.origin && request.headers['access-control-request-private-network'] === 'true') {
          response.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (!tokenMatches(request.headers.authorization, token)) {
        sendJson(
          response,
          401,
          { error: { code: 'unauthorized', message: 'A valid gateway bearer token is required.' } },
          { 'WWW-Authenticate': 'Bearer realm="math-reader-codex-gateway"' },
        );
        return;
      }
      if (url.search) throw new GatewayError('invalid_request', 'Query parameters are not supported.', 400);

      cancellation = requestSignal(request, response, config.requestTimeoutMs);
      if (request.method === 'POST' && url.pathname === '/v1/lecture-jobs') {
        const body = await readJsonBody(request, config.maxBodyBytes, cancellation.signal);
        sendJson(response, 202, lectureJobs.create(body));
        return;
      }
      if (request.method === 'GET' && jobMatch) {
        sendJson(response, 200, lectureJobs.read(jobMatch[1]));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        sendJson(response, 200, await engine.status());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(response, 200, await engine.models({ signal: cancellation.signal }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/ask') {
        const body = await readJsonBody(request, config.maxBodyBytes, cancellation.signal);
        const result = await engine.ask(body, { signal: cancellation.signal });
        sendJson(response, 200, result);
        return;
      }
      throw new GatewayError('not_found', 'Endpoint not found.', 404);
    } catch (error) {
      const failure = asGatewayError(error);
      sendJson(
        response,
        failure.statusCode,
        { error: { code: failure.code, message: failure.message } },
        failure.code === 'request_too_large' || failure.code === 'request_timeout'
          ? { Connection: 'close' }
          : {},
      );
    } finally {
      cancellation?.cleanup();
    }
  };
}

function loopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export async function createGateway(config = loadConfig(), options = {}) {
  const runtime = await ensureRuntimeState(config);
  const token = options.token || runtime.token;
  const appServer = options.appServer || new CodexAppServer(config);
  const engine = options.engine || new GatewayEngine(config, appServer, options);
  const managesEngine = options.startEngine !== false;
  try {
    if (managesEngine) await engine.start();
    const tls = options.tls === undefined ? await readTlsOptions(config) : options.tls;
    if (!loopbackHost(config.host) && !tls && !config.allowInsecureRemote) {
      throw new GatewayError(
        'insecure_remote_bind_refused',
        'A non-loopback bind requires TLS or MATH_READER_GATEWAY_ALLOW_INSECURE_REMOTE=1 behind a private HTTPS/VPN boundary.',
        500,
      );
    }
    const handler = createGatewayHandler({ config, engine, token });
    const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
    server.requestTimeout = config.requestTimeoutMs + 30_000;
    server.headersTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    return { server, engine, tokenFile: config.tokenFile, tls: Boolean(tls) };
  } catch (error) {
    if (managesEngine) await engine.stop().catch(() => {});
    throw error;
  }
}

export async function startGateway(config = loadConfig(), options = {}) {
  const gateway = await createGateway(config, options);
  try {
    await new Promise((resolve, reject) => {
      gateway.server.once('error', reject);
      gateway.server.listen(config.port, config.host, () => {
        gateway.server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await gateway.engine.stop().catch(() => {});
    throw error;
  }
  const address = gateway.server.address();
  const protocol = gateway.tls ? 'https' : 'http';
  const host = typeof address === 'object' && address?.family === 'IPv6' ? `[${config.host}]` : config.host;
  process.stdout.write(
    `math-reader-codex gateway listening on ${protocol}://${host}:${address.port}\n` +
      `Bearer token file: ${gateway.tokenFile}\n`,
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    let closeCompleted = false;
    const closed = new Promise((resolve) => {
      gateway.server.close(() => {
        closeCompleted = true;
        resolve();
      });
    });
    await gateway.engine.stop().catch(() => {});
    gateway.server.closeIdleConnections?.();
    await Promise.race([
      closed,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ]);
    if (!closeCompleted) {
      gateway.server.closeAllConnections?.();
      await closed;
    }
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  return { ...gateway, stop };
}

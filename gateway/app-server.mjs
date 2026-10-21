import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  appServerArguments,
  ensureRuntimeState,
  sanitizedCodexEnvironment,
} from './config.mjs';
import { GatewayError, abortError } from './errors.mjs';

const INITIALIZE_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 16_384;

function appServerFailure(message, cause) {
  return new GatewayError('codex_unavailable', message, 503, { cause });
}

function negativeToolResponse(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'cancel' };
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { decision: 'abort' };
    case 'mcpServer/elicitation/request':
      return { action: 'cancel' };
    case 'item/permissions/requestApproval':
      return {
        permissions: {
          fileSystem: {
            entries: [
              {
                access: 'deny',
                path: { type: 'special', value: { kind: 'root' } },
              },
            ],
          },
          network: { enabled: false },
        },
        scope: 'turn',
      };
    case 'item/tool/call':
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: 'Tools are disabled by this gateway.' }],
      };
    default:
      return null;
  }
}

export class CodexAppServer extends EventEmitter {
  constructor(config, options = {}) {
    super();
    // Concurrent turns install listeners which are removed on completion.
    this.setMaxListeners(0);
    this.config = config;
    this.spawn = options.spawn || spawn;
    this.arguments = options.arguments || appServerArguments();
    this.environment = options.environment || process.env;
    this.child = null;
    this.initialized = false;
    this.closed = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stderr = '';
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.closed);
  }

  async start() {
    if (this.initialized && this.running) return;
    if (this.child && !this.closed) {
      throw appServerFailure('Codex app-server is already starting.');
    }

    await ensureRuntimeState(this.config);
    this.closed = false;
    this.stderr = '';
    const environment = sanitizedCodexEnvironment(this.environment, this.config);
    let child;
    try {
      child = this.spawn(this.config.codexBin, this.arguments, {
        cwd: this.config.workspaceDirectory,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw appServerFailure(`Could not start Codex at ${this.config.codexBin}.`, error);
    }
    this.child = child;
    child.once('error', (error) => this.#handleExit(error));
    child.once('exit', (code, signal) => {
      const diagnostic = this.stderr.trim().slice(-1000);
      this.#handleExit(
        appServerFailure(
          `Codex app-server exited (${signal || `code ${code ?? 'unknown'}`}).`,
          diagnostic ? new Error(`Codex stderr: ${diagnostic}`) : undefined,
        ),
      );
    });
    child.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-STDERR_LIMIT);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#handleLine(line));

    try {
      await this.request(
        'initialize',
        {
          clientInfo: {
            name: 'math-reader-codex',
            title: 'math-reader-codex',
            version: '0.1.0',
          },
        },
        { timeoutMs: INITIALIZE_TIMEOUT_MS },
      );
      this.notify('initialized');
      this.initialized = true;
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  notify(method, params) {
    this.#write(params === undefined ? { method } : { method, params });
  }

  request(method, params = {}, options = {}) {
    if (!this.child || this.closed) {
      return Promise.reject(appServerFailure('Codex app-server is not running.'));
    }
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const waitForLateResult = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (typeof options.onLateResult !== 'function') {
          this.pending.delete(id);
          return;
        }
        const lateResultTimer = setTimeout(() => {
          this.pending.delete(id);
        }, options.lateResultTimeoutMs ?? RPC_TIMEOUT_MS);
        lateResultTimer.unref?.();
        this.pending.set(id, {
          resolve: (result) => {
            clearTimeout(lateResultTimer);
            this.pending.delete(id);
            void Promise.resolve()
              .then(() => options.onLateResult(result))
              .catch(() => {});
          },
          reject: () => {
            clearTimeout(lateResultTimer);
            this.pending.delete(id);
          },
        });
      };
      const onAbort = () => {
        waitForLateResult();
        reject(abortError(options.signal));
      };
      const timer = setTimeout(() => {
        waitForLateResult();
        reject(
          new GatewayError(
            'codex_timeout',
            `Codex app-server did not answer ${method} in time.`,
            504,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        cleanup();
        reject(appServerFailure(`Could not send ${method} to Codex.`, error));
      }
    });
  }

  async readAccount(options = {}) {
    const response = await this.request(
      'account/read',
      { refreshToken: Boolean(options.refreshToken) },
      options,
    );
    return response?.account || null;
  }

  async listModels(options = {}) {
    const models = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const response = await this.request(
        'model/list',
        { cursor, includeHidden: false, limit: 100 },
        options,
      );
      if (!Array.isArray(response?.data)) {
        throw appServerFailure('Codex returned an invalid model catalog.');
      }
      models.push(...response.data);
      cursor = response.nextCursor || null;
      if (!cursor) return models;
    }
    throw appServerFailure('Codex model catalog pagination did not terminate.');
  }

  waitForNotification(method, predicate = () => true, options = {}) {
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.removeListener('notification', onNotification);
        this.removeListener('closed', onClosed);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const onNotification = (notification) => {
        if (notification.method !== method || !predicate(notification.params)) return;
        cleanup();
        resolve(notification.params);
      };
      const onClosed = (error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError(options.signal));
      };
      this.on('notification', onNotification);
      this.once('closed', onClosed);
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async stop() {
    if (!this.child || this.closed) return;
    const child = this.child;
    this.closed = true;
    this.initialized = false;
    const failure = appServerFailure('Codex app-server stopped.');
    for (const pending of [...this.pending.values()]) pending.reject(failure);
    this.pending.clear();
    this.emit('closed', failure);
    child.stdin?.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable || this.closed) {
      throw appServerFailure('Codex app-server input is closed.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('protocolWarning', `Ignored non-JSON app-server output: ${line.slice(0, 200)}`);
      return;
    }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) {
        pending.reject(
          new GatewayError(
            /(?:\b401\b|unauthorized|refresh[_ -]?token|token.{0,30}(?:expired|revoked)|sign[ -]?in|log[ -]?in required|(?:codex account|chatgpt) authentication required)/i.test(message.error.message || '')
              ? 'chatgpt_login_required' : 'codex_rpc_error',
            message.error.message || 'Codex app-server rejected the request.',
            502,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      this.#handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.emit('notification', { method: message.method, params: message.params });
    }
  }

  #handleServerRequest(message) {
    const result = negativeToolResponse(message.method);
    if (result) {
      this.#write({ id: message.id, result });
      this.emit('blockedToolRequest', { method: message.method, params: message.params });
      return;
    }
    this.#write({
      id: message.id,
      error: { code: -32601, message: 'This gateway does not expose client tools or auth callbacks.' },
    });
    this.emit('blockedToolRequest', { method: message.method, params: message.params });
  }

  #handleExit(error) {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    this.initialized = false;
    const failure =
      error instanceof GatewayError
        ? error
        : appServerFailure('Codex app-server stopped unexpectedly.', error);
    for (const pending of [...this.pending.values()]) pending.reject(failure);
    this.pending.clear();
    this.emit('closed', failure);
  }
}

export function publicAuth(account) {
  if (account?.type !== 'chatgpt') return { type: 'none' };
  return {
    type: 'chatgpt',
    ...(account.email ? { email: account.email } : {}),
    ...(account.planType ? { planType: account.planType } : {}),
  };
}

export function requireChatgptAccount(account) {
  if (account?.type === 'apiKey') {
    throw new GatewayError(
      'chatgpt_login_required',
      'API-key authentication is refused. Sign in with ChatGPT from API Setting, or run `npm run login`.',
      503,
    );
  }
  if (account?.type !== 'chatgpt') {
    throw new GatewayError(
      'chatgpt_login_required',
      'This isolated gateway is not signed in to ChatGPT. Sign in from API Setting, or run `npm run login`.',
      503,
    );
  }
  return account;
}

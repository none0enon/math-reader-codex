import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { publicAuth, requireChatgptAccount } from './app-server.mjs';
import { DISABLED_CODEX_FEATURES } from './config.mjs';
import { GatewayError, abortError } from './errors.mjs';
import { prepareImageUploads } from './image-uploads.mjs';
import { LECTURE_QUALITY_INSTRUCTIONS } from './lecture-instructions.mjs';
import { preparePdfAttachment } from './pdf.mjs';
import {
  buildCodexInput,
  validateAskBody,
} from './request.mjs';

const FORBIDDEN_ITEM_TYPES = new Set([
  'collabAgentToolCall',
  'commandExecution',
  'dynamicToolCall',
  'fileChange',
  'functionCallOutput',
  'imageGeneration',
  'imageView',
  'mcpToolCall',
  'sleep',
  'subAgentActivity',
  'webSearch',
]);

// The official CLI states the same lifetime for its one-time device codes.
const DEVICE_CODE_LIFETIME_MS = 15 * 60_000;

function describeError(error) {
  const message = error?.message || String(error || 'Codex failed.');
  const cause = error?.cause?.message;
  return (cause && !message.includes(cause) ? `${message} (${cause})` : message).slice(0, 1000);
}

function reasoningEfforts(model) {
  return (model.supportedReasoningEfforts || [])
    .map((option) => (typeof option === 'string' ? option : option?.reasoningEffort))
    .filter((effort) => typeof effort === 'string');
}

function publicModel(model) {
  const efforts = reasoningEfforts(model);
  return {
    id: model.model || model.id,
    ...(model.displayName ? { name: model.displayName } : {}),
    ...(efforts.length ? { reasoningEfforts: efforts } : {}),
  };
}

function codexErrorKind(info) {
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object') return Object.keys(info)[0] || 'other';
  return 'other';
}

function turnFailure(turn) {
  const error = turn?.error;
  const kind = codexErrorKind(error?.codexErrorInfo);
  switch (kind) {
    case 'contextWindowExceeded':
      return new GatewayError(
        'context_length_exceeded',
        error?.message || 'The request exceeds the model context window.',
        413,
      );
    case 'rateLimitExceeded':
    case 'serverOverloaded':
    case 'usageLimitExceeded':
      return new GatewayError('codex_rate_limited', error?.message || 'Codex is rate limited.', 429);
    case 'unauthorized':
      return new GatewayError(
        'chatgpt_login_required',
        'The isolated ChatGPT login is no longer authorized. Sign in again from API Setting, or run `npm run login`.',
        503,
      );
    case 'badRequest':
      return new GatewayError('codex_bad_request', error?.message || 'Codex rejected the input.', 400);
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
      // Codex retried after upstream ended the response stream early (HTTP
      // streams were observed to end after about 15 minutes) and gave up.
      return new GatewayError(
        'codex_stream_disconnected',
        'ChatGPT repeatedly ended the response stream before Codex finished (HTTP streams were observed to end after about 15 minutes). Use a smaller page range or lower reasoning effort.',
        502,
      );
    default:
      return new GatewayError('codex_turn_failed', error?.message || 'Codex failed the turn.', 502);
  }
}

function finalText(turn, observedMessages) {
  const messages = [
    ...observedMessages,
    ...(turn?.items || []).filter((item) => item?.type === 'agentMessage'),
  ];
  const finals = messages.filter((item) => item.phase === 'final_answer');
  const unknown = messages.filter((item) => item.phase == null);
  const chosen = finals.at(-1) || unknown.at(-1) || messages.at(-1);
  return typeof chosen?.text === 'string' ? chosen.text : '';
}

export class GatewayEngine {
  constructor(config, appServer, options = {}) {
    this.config = config;
    this.appServer = appServer;
    this.preparePdf = options.preparePdf || preparePdfAttachment;
    this.prepareImages = options.prepareImages || prepareImageUploads;
    this.activeRequests = 0;
    this.statusCheck = null;
    this.appServerStart = null;
    this.appServerStartedAt = 0;
    // The device-code sign-in currently offered to the user, or why the last one ended.
    this.login = null;
    this.loginStart = null;
    this.appServer.on('notification', (notification) => this.#onNotification(notification));
    this.appServer.on('closed', () => this.#onAppServerClosed());
  }

  async start() {
    await this.#ensureAppServer();
  }

  async stop() {
    await this.appServer.stop();
  }

  // Codex is restarted on demand after it exits, so a crashed app-server does
  // not leave the gateway unusable until `npm start` is run again.
  async #ensureAppServer() {
    if (this.appServer.running && this.appServer.initialized) return;
    this.appServerStart ||= (async () => {
      this.appServerStartedAt = Date.now();
      await this.appServer.start();
    })().finally(() => { this.appServerStart = null; });
    await this.appServerStart;
  }

  // A running app-server keeps its in-memory login, so `npm run login` in
  // another process only takes effect after Codex restarts.
  async #reloadExternalLogin() {
    if (this.activeRequests || this.loginStart || this.appServerStart) return false;
    let modified;
    try {
      modified = (await stat(join(this.config.codexHome, 'auth.json'))).mtimeMs;
    } catch {
      return false;
    }
    if (modified <= this.appServerStartedAt) return false;
    await this.appServer.stop();
    await this.#ensureAppServer();
    return true;
  }

  #onAppServerClosed() {
    // A device code belongs to the app-server process that requested it.
    if (this.login?.status === 'pending') {
      this.login = { status: 'failed', error: 'Codex restarted before sign-in completed.' };
    }
  }

  #onNotification({ method, params }) {
    if (method !== 'account/login/completed') return;
    if (this.login?.status !== 'pending' || params?.loginId !== this.login.loginId) return;
    if (params.success) {
      this.login = null;
      process.stdout.write('ChatGPT sign-in completed.\n');
      return;
    }
    this.login = { status: 'failed', error: params.error || 'ChatGPT sign-in was not completed.' };
    process.stdout.write(`ChatGPT sign-in was not completed: ${this.login.error}\n`);
  }

  #publicLogin() {
    if (this.login?.status === 'pending' && Date.now() >= this.login.expiresAt) {
      this.login = { status: 'failed', error: 'The device code expired.' };
    }
    const login = this.login;
    if (!login) return null;
    return login.status === 'pending'
      ? {
          status: 'pending',
          verificationUrl: login.verificationUrl,
          userCode: login.userCode,
          expiresAt: new Date(login.expiresAt).toISOString(),
        }
      : { status: 'failed', error: login.error };
  }

  async status() {
    // Share only simultaneous probes; every later check verifies upstream again.
    if (this.statusCheck) return this.statusCheck;
    this.statusCheck = this.#status().finally(() => { this.statusCheck = null; });
    return this.statusCheck;
  }

  async #status() {
    let account = null;
    let statusError;
    const verify = async (refreshToken) => {
      account = await this.appServer.readAccount({ refreshToken, timeoutMs: 12_000 });
      requireChatgptAccount(account);
      // This authenticated upstream request also detects a revoked access token.
      await this.appServer.request('account/rateLimits/read', {}, { timeoutMs: 12_000 });
    };
    const loginRejected = (error) => {
      if (error?.code !== 'chatgpt_login_required') throw error;
    };
    try {
      await this.#ensureAppServer();
      try {
        await verify(false);
      } catch (error) {
        loginRejected(error);
        // Refresh tokens rotate, so refresh only after ChatGPT rejected the login.
        try {
          await verify(true);
        } catch (refreshError) {
          loginRejected(refreshError);
          // A login written by `npm run login` needs a fresh Codex process.
          if (!(await this.#reloadExternalLogin())) throw refreshError;
          await verify(false);
        }
      }
    } catch (error) {
      statusError = error;
    }
    const auth = publicAuth(account);
    const ready = Boolean(this.appServer.running && this.appServer.initialized && auth.type === 'chatgpt' && !statusError);
    const loginRequired = statusError?.code === 'chatgpt_login_required' || account?.type === 'apiKey';
    if (ready && this.login) {
      const { loginId } = this.login;
      this.login = null;
      if (loginId) void this.appServer.request('account/login/cancel', { loginId }, { timeoutMs: 5_000 }).catch(() => {});
    }
    return {
      ready,
      checkedAt: new Date().toISOString(),
      recovery: ready ? null : loginRequired ? 'login' : 'gateway',
      auth,
      login: this.#publicLogin(),
      appServer: {
        running: this.appServer.running,
        initialized: this.appServer.initialized,
      },
      requests: { active: this.activeRequests, pending: 0 },
      ...(account?.type === 'apiKey' ? { authError: 'api_key_auth_refused' } : {}),
      ...(statusError
        ? { statusError: statusError.code || 'codex_unavailable', statusMessage: describeError(statusError) }
        : {}),
    };
  }

  async startLogin() {
    await this.#ensureAppServer();
    const pending = this.#publicLogin();
    if (pending?.status === 'pending') return pending;
    // Another device-code request would cancel the code already shown to the user.
    this.loginStart ||= this.#requestDeviceCode().finally(() => { this.loginStart = null; });
    return this.loginStart;
  }

  async #requestDeviceCode() {
    const result = await this.appServer.request('account/login/start', { type: 'chatgptDeviceCode' });
    let verificationUrl = null;
    try {
      verificationUrl = new URL(result?.verificationUrl);
    } catch {}
    if (verificationUrl?.protocol !== 'https:' || typeof result?.userCode !== 'string' || !result.userCode
        || typeof result?.loginId !== 'string') {
      throw new GatewayError(
        'codex_login_unavailable',
        'Codex did not return a ChatGPT device code. Run `npm ci` in the gateway directory and restart the gateway, or run `npm run login`.',
        502,
      );
    }
    this.login = {
      status: 'pending',
      loginId: result.loginId,
      verificationUrl: verificationUrl.href,
      userCode: result.userCode,
      expiresAt: Date.now() + DEVICE_CODE_LIFETIME_MS,
    };
    process.stdout.write(
      `ChatGPT sign-in: open ${verificationUrl.href} and enter code ${result.userCode} (expires in 15 minutes).\n`,
    );
    return this.#publicLogin();
  }

  async models({ signal } = {}) {
    await this.#ensureAppServer();
    const account = await this.appServer.readAccount({ signal });
    requireChatgptAccount(account);
    const catalog = await this.appServer.listModels({ signal });
    return { data: catalog.filter((model) => !model.hidden).map(publicModel) };
  }

  async ask(body, { signal, onProgress, onStart, lecture = false } = {}) {
    const request = validateAskBody(body);
    if (signal?.aborted) throw abortError(signal);
    this.activeRequests += 1;
    try {
      onStart?.();
      return await this.#execute(request, signal, onProgress, lecture);
    } finally {
      this.activeRequests -= 1;
    }
  }

  async #chooseModel(request, signal) {
    const catalog = await this.appServer.listModels({ signal });
    const visible = catalog.filter((model) => !model.hidden);
    const chosen = request.model
      ? visible.find((model) => model.model === request.model || model.id === request.model)
      : visible.find((model) => model.isDefault) || visible[0];
    if (!chosen) {
      throw new GatewayError(
        'invalid_model',
        request.model ? `Unknown Codex model: ${request.model}.` : 'No Codex model is available.',
        400,
      );
    }
    const hasImages =
      Boolean(request.pdfAttachment) ||
      request.messages.some((message) => message.content.some((block) => block.type === 'image'));
    if (hasImages && Array.isArray(chosen.inputModalities) && !chosen.inputModalities.includes('image')) {
      throw new GatewayError('invalid_model', 'The selected Codex model does not accept images.', 400);
    }
    if (request.reasoningEffort && !reasoningEfforts(chosen).includes(request.reasoningEffort)) {
      throw new GatewayError(
        'invalid_reasoning_effort',
        `The selected model does not support reasoning effort: ${request.reasoningEffort}.`,
        400,
      );
    }
    return chosen;
  }

  async #execute(request, signal, onProgress, lecture) {
    if (signal?.aborted) throw abortError(signal);
    // Forward readable summaries and answer text; raw reasoning stays private.
    let progress = { stage: 'preparing', partialText: '', commentaryText: '', reasoningSummary: '' };
    const report = (update) => {
      if (!onProgress) return;
      progress = { ...progress, ...update };
      onProgress(progress);
    };
    report({});
    let messageId;
    const messagePhases = new Map();
    const commentaryMessages = new Map();
    const reasoningSummaries = new Map();
    const summaryIndexes = new Map();
    const reportCommentary = (id, text) => {
      commentaryMessages.set(id, text);
      report({ commentaryText: [...commentaryMessages.values()].join('\n\n') });
    };
    const reportSummary = (id, text) => {
      reasoningSummaries.set(id, text);
      report({ stage: stageFor('reasoning'), reasoningSummary: [...reasoningSummaries.values()].join('\n\n') });
    };
    // When ChatGPT ends the response stream early (HTTP streams were observed
    // to end after about 15 minutes), Codex retries the sampling request:
    // completed reasoning is kept, but the unfinished answer is written again
    // from its beginning. Keep showing the longest earlier preview until the
    // new attempt overtakes it.
    let liveText = '';
    let retainedText = '';
    let retries = 0;
    const stageFor = (stage) => (retainedText ? 'retrying' : stage);
    const reportText = (text) => {
      liveText = text;
      if (retainedText && liveText.length < retainedText.length) {
        report({ stage: 'retrying', partialText: retainedText });
        return;
      }
      retainedText = '';
      report({ stage: 'writing', partialText: liveText });
    };
    const completedMessages = new Set();
    const beginRetry = () => {
      retries += 1;
      if (liveText.length > retainedText.length) retainedText = liveText;
      liveText = '';
      messageId = undefined;
      if (onProgress) report({ stage: 'retrying', retries });
    };
    // Codex hides the first WebSocket retry notification, so a new answer
    // replacing an unfinished one also marks a retry.
    const enterMessage = (id) => {
      if (messageId && messageId !== id && !completedMessages.has(messageId) && liveText) beginRetry();
      messageId = id;
    };
    await this.#ensureAppServer();
    // Turns recover an expired access token inside Codex. Forcing a refresh
    // per request would rotate the refresh token for every concurrent request.
    const account = await this.appServer.readAccount({ signal });
    requireChatgptAccount(account);
    const selectedModel = await this.#chooseModel(request, signal);
    const model = selectedModel.model || selectedModel.id;
    const directory = await mkdtemp(join(this.config.temporaryDirectory, 'request-'));
    let threadId = null;
    let turnId = null;
    let abortRequested = false;
    const observedMessages = [];
    let rejectCompletion;
    let resolveCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // A tool notification or disconnect can arrive while turn/start is still in
    // flight. Attach a rejection handler immediately so that fail-closed events
    // cannot briefly become unhandled rejections before we await completion.
    void completion.catch(() => {});

    const unsubscribeThread = (id) =>
      this.appServer
        .request('thread/unsubscribe', { threadId: id }, { timeoutMs: 5_000 })
        .catch(() => {});
    const cleanUpLateTurn = async (id, lateTurnId) => {
      if (lateTurnId) {
        await this.appServer
          .request(
            'turn/interrupt',
            { threadId: id, turnId: lateTurnId },
            { timeoutMs: 5_000 },
          )
          .catch(() => {});
      }
      await unsubscribeThread(id);
    };
    const interrupt = () => {
      abortRequested = true;
      if (threadId && turnId) {
        void this.appServer
          .request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5_000 })
          .catch(() => {});
      } else if (threadId) {
        void unsubscribeThread(threadId);
      }
    };
    const onNotification = (notification) => {
      const params = notification.params;
      if (!threadId || params?.threadId !== threadId) return;
      if (turnId && params.turnId && params.turnId !== turnId) return;
      if (notification.method === 'error' && params?.willRetry === true) {
        // The unfinished message is discarded; the retry streams a new item.
        beginRetry();
      }
      if (notification.method === 'item/completed' || notification.method === 'item/started') {
        const item = params?.item;
        if (FORBIDDEN_ITEM_TYPES.has(item?.type)) {
          interrupt();
          rejectCompletion(
            new GatewayError(
              'tool_use_blocked',
              `Codex attempted disabled tool activity: ${item.type}.`,
              502,
            ),
          );
          return;
        }
        if (notification.method === 'item/completed' && item?.type === 'agentMessage') {
          observedMessages.push(item);
        }
        if (onProgress && item?.type === 'agentMessage') {
          messagePhases.set(item.id, item.phase);
          if (item.phase === 'commentary') {
            reportCommentary(item.id, String(item.text || commentaryMessages.get(item.id) || ''));
          } else {
            enterMessage(item.id);
            if (notification.method === 'item/completed') {
              completedMessages.add(item.id);
              // A completed attempt is authoritative even if it is shorter.
              retainedText = '';
            }
            reportText(String(item.text || ''));
          }
        }
        if (onProgress && item?.type === 'reasoning') {
          const summary = (item.summary || []).filter(part => typeof part === 'string').join('\n\n');
          if (summary || !reasoningSummaries.has(item.id)) reportSummary(item.id, summary);
        }
      }
      if (onProgress && notification.method === 'item/agentMessage/delta'
          && typeof params.delta === 'string') {
        if (messagePhases.get(params.itemId) === 'commentary') {
          reportCommentary(params.itemId, (commentaryMessages.get(params.itemId) || '') + params.delta);
        } else {
          const previous = messageId === params.itemId ? liveText : '';
          enterMessage(params.itemId);
          reportText(previous + params.delta);
        }
      }
      if (onProgress && notification.method === 'item/reasoning/summaryTextDelta'
          && typeof params.delta === 'string') {
        const previous = reasoningSummaries.get(params.itemId) || '';
        const separator = previous && summaryIndexes.get(params.itemId) !== params.summaryIndex ? '\n\n' : '';
        summaryIndexes.set(params.itemId, params.summaryIndex);
        reportSummary(params.itemId, previous + separator + params.delta);
      }
      if (notification.method === 'turn/completed' && (!turnId || params?.turn?.id === turnId)) {
        resolveCompletion(params.turn);
      }
    };
    const onBlockedTool = ({ method, params }) => {
      if (!threadId) return;
      if (params?.threadId && params.threadId !== threadId) return;
      interrupt();
      rejectCompletion(
        new GatewayError('tool_use_blocked', `Codex requested disabled client method: ${method}.`, 502),
      );
    };
    const onClosed = (error) => rejectCompletion(error);
    const onAbort = () => {
      interrupt();
      rejectCompletion(abortError(signal));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    this.appServer.on('notification', onNotification);
    this.appServer.on('blockedToolRequest', onBlockedTool);
    this.appServer.once('closed', onClosed);
    try {
      const pdf = request.pdfAttachment
        ? await this.preparePdf(request.pdfAttachment, { directory, signal })
        : null;
      const input = await this.prepareImages(
        await buildCodexInput(request, pdf, directory), this.config, { signal },
      );
      report({ stage: 'connecting' });
      const features = Object.fromEntries(DISABLED_CODEX_FEATURES.map((name) => [name, false]));
      features.skip_host_skill_discovery = true;
      const threadResponse = await this.appServer.request(
        'thread/start',
        {
          model,
          cwd: this.config.workspaceDirectory,
          ephemeral: true,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          personality: 'none',
          serviceName: 'math-reader-codex',
          // Replace Codex's coding-agent defaults with the application's exact prompt.
          baseInstructions: request.systemPrompt,
          ...(lecture ? { developerInstructions: LECTURE_QUALITY_INSTRUCTIONS } : {}),
          config: { web_search: 'disabled', features },
        },
        {
          signal,
          onLateResult: (response) => {
            const lateThreadId = response?.thread?.id;
            if (lateThreadId) void unsubscribeThread(lateThreadId);
          },
        },
      );
      threadId = threadResponse?.thread?.id;
      if (!threadId) throw new GatewayError('codex_protocol_error', 'Codex omitted the thread id.', 502);
      report({ stage: 'generating' });
      const turnResponse = await this.appServer.request(
        'turn/start',
        {
          threadId,
          input,
          model,
          ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
          ...(onProgress ? { summary: 'auto' } : {}),
        },
        {
          signal,
          onLateResult: (response) => {
            const lateTurnId = response?.turn?.id;
            void cleanUpLateTurn(threadId, lateTurnId);
          },
        },
      );
      turnId = turnResponse?.turn?.id;
      if (!turnId) throw new GatewayError('codex_protocol_error', 'Codex omitted the turn id.', 502);
      if (abortRequested || signal?.aborted) interrupt();
      const turn = await completion;
      if (turn?.status === 'failed') throw turnFailure(turn);
      if (turn?.status !== 'completed') {
        throw signal?.aborted
          ? abortError(signal)
          : new GatewayError('codex_interrupted', 'Codex interrupted the turn.', 502);
      }
      const text = finalText(turn, observedMessages);
      if (!text) throw new GatewayError('empty_response', 'Codex returned no final answer.', 502);
      return { text, model };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.appServer.removeListener('notification', onNotification);
      this.appServer.removeListener('blockedToolRequest', onBlockedTool);
      this.appServer.removeListener('closed', onClosed);
      if (threadId) {
        await unsubscribeThread(threadId);
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
}

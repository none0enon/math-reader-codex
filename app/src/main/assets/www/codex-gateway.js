(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CodexGateway = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MAX_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
    const DEFAULT_REQUEST_TIMEOUT_MS = MAX_REQUEST_TIMEOUT_MS;
    const DEVICE_LOGIN_URL = 'https://auth.openai.com/codex/device';
    // The gateway enforces the lecture deadline. Reconnected event streams
    // attach to the same background job until that deadline or completion.
    const LECTURE_JOB_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
    // Tolerate brief Wi-Fi/VPN drops or a device waking from sleep.
    const LECTURE_JOB_OFFLINE_GRACE_MS = 2 * 60 * 1000;

    function gatewayError(code, message, status, cause) {
        const safeCode = String(code || 'codex_gateway_error');
        const safeMessage = String(message || 'Codex Gateway request failed');
        const error = new Error(safeCode + ': ' + safeMessage);
        error.code = safeCode;
        if (Number.isFinite(Number(status))) error.status = Number(status);
        if (cause !== undefined) error.cause = cause;
        return error;
    }

    function isLoopbackHostname(hostname) {
        const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host === '::1') return true;
        const match = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        return !!match && match.slice(1).every(part => Number(part) >= 0 && Number(part) <= 255);
    }

    function normalizeBaseUrl(value, options) {
        const raw = String(value || '').trim();
        if (!raw) throw gatewayError('codex_gateway_url_required', 'Codex Gateway URL is required');

        let parsed;
        try {
            parsed = new URL(raw);
        } catch (cause) {
            throw gatewayError('codex_gateway_url_invalid', 'Codex Gateway URL is invalid', undefined, cause);
        }

        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
            throw gatewayError(
                'codex_gateway_url_invalid',
                'Codex Gateway URL must not contain credentials, a query, or a fragment'
            );
        }

        const requireHttps = !!(options && options.requireHttps);
        const isHttps = parsed.protocol === 'https:';
        const isLoopbackHttp = parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
        if (!isHttps && !(isLoopbackHttp && !requireHttps)) {
            throw gatewayError(
                requireHttps ? 'codex_gateway_https_required_boox' : 'codex_gateway_https_required',
                requireHttps
                    ? 'BOOX requires an HTTPS Codex Gateway URL'
                    : 'Use HTTPS, or HTTP only for a loopback Gateway'
            );
        }

        const pathname = parsed.pathname.replace(/\/+$/, '');
        return parsed.origin + (pathname === '/' ? '' : pathname);
    }

    function normalizeToken(value) {
        const token = String(value || '').trim();
        if (!token) {
            throw gatewayError('codex_gateway_token_required', 'Codex Gateway token is required');
        }
        return token;
    }

    function hasAudioContent(messages) {
        return (Array.isArray(messages) ? messages : []).some(message => {
            const content = message && message.content;
            if (!Array.isArray(content)) return false;
            return content.some(item => item && (item.type === 'audio' || item.type === 'input_audio'));
        });
    }

    function serializeContentItem(item) {
        if (!item || typeof item !== 'object') {
            throw gatewayError('codex_content_invalid', 'A multimodal content item must be an object');
        }
        if (item.type === 'text') {
            return { type: 'text', text: String(item.text || '') };
        }
        if (item.type === 'image_url') {
            const rawImageUrl = typeof item.image_url === 'string'
                ? item.image_url
                : item.image_url && item.image_url.url;
            const imageUrl = String(rawImageUrl || '');
            if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(imageUrl)) {
                throw gatewayError(
                    'codex_image_data_url_required',
                    'Codex Gateway images must be base64 data URLs'
                );
            }
            return { type: 'image_url', image_url: { url: imageUrl } };
        }
        if (item.type === 'audio' || item.type === 'input_audio') {
            throw gatewayError('codex_audio_not_supported', 'Audio must be routed to the configured Gemini API');
        }
        throw gatewayError(
            'codex_content_type_unsupported',
            'Unsupported Codex Gateway content type: ' + String(item.type || 'unknown')
        );
    }

    function serializeMessages(messages) {
        if (!Array.isArray(messages)) {
            throw gatewayError('codex_messages_invalid', 'Codex Gateway messages must be an array');
        }
        return messages.map(message => {
            if (!message || typeof message !== 'object') {
                throw gatewayError('codex_message_invalid', 'Each Codex Gateway message must be an object');
            }
            const role = String(message.role || 'user');
            const content = Array.isArray(message.content)
                ? message.content.map(serializeContentItem)
                : String(message.content == null ? '' : message.content);
            return { role, content };
        });
    }

    function bytesToBase64(bytes) {
        const view = bytes instanceof Uint8Array
            ? bytes
            : ArrayBuffer.isView(bytes)
                ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                : bytes instanceof ArrayBuffer
                    ? new Uint8Array(bytes)
                    : null;
        if (!view) throw gatewayError('codex_pdf_invalid', 'PDF bytes are invalid');

        if (typeof Buffer !== 'undefined') {
            return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
        }
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < view.length; offset += chunkSize) {
            binary += String.fromCharCode.apply(null, view.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
    }

    function normalizeBase64(value) {
        const base64 = String(value || '')
            .replace(/^data:application\/pdf;base64,/i, '')
            .replace(/\s+/g, '');
        if (!base64 || !/^[a-z0-9+/]*={0,2}$/i.test(base64)) {
            throw gatewayError('codex_pdf_invalid', 'PDF base64 data is invalid');
        }
        return base64;
    }

    async function serializePdfAttachment(attachment) {
        if (!attachment) return undefined;
        let base64;
        if (attachment.base64) {
            base64 = normalizeBase64(attachment.base64);
        } else {
            let source = attachment.bytes || attachment.blob || attachment.file;
            if (typeof Blob !== 'undefined' && source instanceof Blob) {
                source = await source.arrayBuffer();
            }
            base64 = bytesToBase64(source);
            if (!base64) throw gatewayError('codex_pdf_empty', 'PDF attachment is empty');
        }
        return {
            base64,
            name: String(attachment.name || 'document.pdf')
        };
    }

    async function buildAskPayload(input) {
        const options = input || {};
        if (hasAudioContent(options.messages)) {
            throw gatewayError('codex_audio_not_supported', 'Audio must be routed to the configured Gemini API');
        }
        const payload = {
            systemPrompt: String(options.systemPrompt || ''),
            messages: serializeMessages(options.messages || [])
        };
        const model = String(options.model || '').trim();
        const reasoningEffort = String(options.reasoningEffort || '').trim();
        if (model) payload.model = model;
        if (reasoningEffort) payload.reasoningEffort = reasoningEffort;
        const pdfAttachment = await serializePdfAttachment(options.pdfAttachment);
        if (pdfAttachment) payload.pdfAttachment = pdfAttachment;
        return payload;
    }

    function endpointUrl(config, path) {
        return normalizeBaseUrl(config && config.baseUrl, {
            requireHttps: !!(config && config.requireHttps)
        }) + path;
    }

    async function readResponseJson(response) {
        const raw = await response.text();
        if (!raw) return {};
        try {
            return JSON.parse(raw);
        } catch (cause) {
            throw gatewayError(
                'codex_gateway_response_invalid',
                'Codex Gateway returned invalid JSON',
                response.status,
                cause
            );
        }
    }

    async function readEventStream(response, onEvent, onActivity) {
        if (!response.body || !response.body.getReader) {
            throw gatewayError('codex_gateway_stream_unavailable', 'This browser cannot read streaming responses.');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', event = 'message', lines = [];
        const line = value => {
            if (value === '') {
                const done = lines.length && onEvent(event, lines.join('\n')) === true;
                event = 'message'; lines = [];
                return done;
            }
            if (value.startsWith(':')) return false;
            const colon = value.indexOf(':');
            const field = colon < 0 ? value : value.slice(0, colon);
            let data = colon < 0 ? '' : value.slice(colon + 1);
            if (data.startsWith(' ')) data = data.slice(1);
            if (field === 'event') event = data;
            if (field === 'data') lines.push(data);
            return false;
        };
        try {
            while (true) {
                const chunk = await reader.read();
                onActivity?.();
                buffer += decoder.decode(chunk.value, { stream: !chunk.done });
                let match;
                while ((match = /\r\n|\r|\n/.exec(buffer))) {
                    if (!chunk.done && match[0] === '\r' && match.index === buffer.length - 1) break;
                    const value = buffer.slice(0, match.index);
                    buffer = buffer.slice(match.index + match[0].length);
                    if (line(value)) return;
                }
                if (chunk.done) return;
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }

    function reportProgress(callback, progress) {
        if (typeof callback !== 'function') return;
        try { callback(progress); }
        catch (error) { console.warn('AI preview could not be displayed', error); }
    }

    async function requestJson(config, path, options) {
        const requestOptions = options || {};
        const fetchImpl = requestOptions.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
        if (!fetchImpl) throw gatewayError('codex_gateway_fetch_unavailable', 'Fetch is unavailable');

        const requestedTimeout = Number(requestOptions.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;
        const maximumTimeout = requestOptions.resumable ? LECTURE_JOB_MAX_WAIT_MS : MAX_REQUEST_TIMEOUT_MS;
        const timeoutMs = Math.min(maximumTimeout, Math.max(1, requestedTimeout));
        const controller = new AbortController();
        let timedOut = false;
        let idleTimer;
        const touchStream = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
        };
        const timer = setTimeout(function () {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const externalSignal = requestOptions.signal;
        const abortFromExternal = function () { controller.abort(); };
        if (externalSignal) {
            if (externalSignal.aborted) controller.abort();
            else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
        }

        try {
            if (requestOptions.resumable) touchStream();
            const headers = {
                'Accept': requestOptions.stream ? 'text/event-stream' : 'application/json',
                'Authorization': 'Bearer ' + normalizeToken(config && config.token)
            };
            if (requestOptions.body !== undefined) headers['Content-Type'] = 'application/json';
            const response = await fetchImpl(endpointUrl(config, path), {
                method: requestOptions.method || 'GET',
                headers,
                body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
                signal: controller.signal
            });
            if (response.ok && requestOptions.stream) {
                touchStream();
                if (!String(response.headers.get('content-type') || '').includes('text/event-stream')) {
                    throw gatewayError('codex_gateway_upgrade_required', 'Update and restart the gateway to enable streaming.');
                }
                let result;
                let completed = false;
                await readEventStream(response, (event, raw) => {
                    let data;
                    try { data = JSON.parse(raw); }
                    catch (cause) { throw gatewayError('codex_gateway_response_invalid', 'The gateway sent an invalid stream event.', undefined, cause); }
                    if (event === 'progress') reportProgress(requestOptions.onProgress, data);
                    if (event === 'error') {
                        const error = gatewayError(data.code, data.message, data.status);
                        error.terminal = true;
                        throw error;
                    }
                    if (event === 'result') { result = data; completed = true; return true; }
                }, touchStream);
                if (!completed) throw gatewayError('codex_gateway_stream_disconnected', 'The gateway stream ended before completion.');
                return result;
            }
            const data = await readResponseJson(response);
            if (!response.ok) {
                const code = data && data.error && data.error.code
                    ? data.error.code
                    : 'codex_gateway_http_' + response.status;
                const message = data && data.error && data.error.message
                    ? data.error.message
                    : 'Codex Gateway request failed with HTTP ' + response.status;
                throw gatewayError(code, message, response.status);
            }
            return data;
        } catch (error) {
            if (controller.signal.aborted) {
                throw gatewayError(
                    timedOut ? 'codex_gateway_timeout' : 'codex_gateway_aborted',
                    timedOut ? 'Codex Gateway request timed out' : 'Codex Gateway request was cancelled',
                    undefined,
                    error
                );
            }
            if (error && typeof error.code === 'string') throw error;
            throw gatewayError('codex_gateway_network_error', error && error.message
                ? error.message
                : 'Unable to reach Codex Gateway', undefined, error);
        } finally {
            clearTimeout(timer);
            clearTimeout(idleTimer);
            if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternal);
        }
    }

    async function getStatus(config, options) {
        return requestJson(config, '/v1/status', options);
    }

    function connectionState(status) {
        if (!status || typeof status !== 'object' || typeof status.ready !== 'boolean') {
            throw gatewayError('codex_gateway_response_invalid', 'The gateway returned an invalid connection status.');
        }
        // Older gateways report auth.type but omit recovery and checkedAt.
        // An explicit unauthenticated account must still offer authorization.
        const loginRequired = status.recovery === 'login' || status.statusError === 'chatgpt_login_required' ||
            status.authError === 'api_key_auth_refused' || ['none', 'apiKey'].includes(status.auth?.type);
        const ready = status.ready && status.auth?.type === 'chatgpt' && !!status.checkedAt &&
            !status.statusError && !loginRequired;
        return {
            ready,
            authType: loginRequired ? 'none' : status.auth?.type === 'chatgpt' ? 'chatgpt' : 'unknown',
            recovery: ready ? null : loginRequired ? 'login' : 'gateway',
            code: ready ? null : loginRequired ? 'chatgpt_login_required' :
                status.statusError || (status.checkedAt ? 'codex_unavailable' : 'codex_gateway_upgrade_required')
        };
    }

    async function startLogin(config, options = {}) {
        let result;
        try {
            result = await requestJson(config, '/v1/login', {
                ...options, method: 'POST', body: {}, timeoutMs: options.timeoutMs || 30_000
            });
        } catch (error) {
            if (error.code === 'not_found' || [404, 405].includes(error.status)) {
                throw gatewayError('codex_gateway_upgrade_required', 'Update and restart the gateway to obtain a device code here.', error.status, error);
            }
            throw error;
        }
        if (!result || result.verificationUrl !== DEVICE_LOGIN_URL ||
            typeof result.userCode !== 'string' || !result.userCode.trim()) {
            throw gatewayError('codex_login_unavailable', 'The gateway did not return a valid device authorization code.');
        }
        return { verificationUrl: DEVICE_LOGIN_URL, userCode: result.userCode.trim() };
    }

    async function listModels(config, options) {
        const data = await requestJson(config, '/v1/models', options);
        if (!Array.isArray(data.data)) {
            throw gatewayError('codex_gateway_models_invalid', 'Codex Gateway model list is invalid');
        }
        return data.data.map(model => ({
            id: String(model && model.id || ''),
            name: model && model.name ? String(model.name) : '',
            reasoningEfforts: Array.isArray(model && model.reasoningEfforts)
                ? model.reasoningEfforts.map(value => String(value)).filter(Boolean)
                : []
        })).filter(model => model.id);
    }

    async function ask(config, input, options) {
        const payload = await buildAskPayload(input);
        const data = options && options.lectureJob
            ? await askLectureJob(config, payload, options)
            : await requestJson(config, '/v1/ask', {
                ...(options || {}),
                stream: true,
                method: 'POST',
                body: payload
            });
        if (typeof data.text !== 'string') {
            throw gatewayError('codex_gateway_answer_invalid', 'Codex Gateway response is missing text');
        }
        return { text: data.text, model: data.model ? String(data.model) : '' };
    }

    async function askLectureJob(config, payload, options) {
        const id = options.lectureJob.id || globalThis.crypto.randomUUID();
        // Persist the id before submission: a lost POST response can be retried
        // with the same id without paying for a second inference request.
        if (options.lectureJob.onCreated) options.lectureJob.onCreated(id);
        const deadline = Date.now() + LECTURE_JOB_MAX_WAIT_MS;
        let submitted = Boolean(options.lectureJob.id);
        let lastNetworkError;
        let networkFailures = 0;
        let offlineSince = 0;
        const report = progress => {
            if (typeof options.lectureJob.onProgress === 'function') {
                // A preview rendering failure must not discard the final lecture.
                try { options.lectureJob.onProgress(progress); }
                catch (error) { console.warn('Lecture preview could not be displayed', error); }
            }
        };
        while (Date.now() < deadline) {
            if (options.signal && options.signal.aborted) {
                throw gatewayError('codex_gateway_aborted', 'Stopped waiting for the lecture; reopen it to resume.');
            }
            let job;
            try {
                if (!submitted) {
                    job = await requestJson(config, '/v1/lecture-jobs', {
                        fetchImpl: options.fetchImpl, signal: options.signal,
                        timeoutMs: 30 * 1000, method: 'POST', body: { id, request: payload }
                    });
                    submitted = true;
                }
                if (!job || job.status === 'pending') job = await requestJson(config, '/v1/lecture-jobs/' + id + '/events', {
                    fetchImpl: options.fetchImpl,
                    signal: options.signal,
                    timeoutMs: LECTURE_JOB_MAX_WAIT_MS,
                    resumable: true,
                    stream: true,
                    onProgress: report
                });
                submitted = true;
                lastNetworkError = null;
                networkFailures = 0;
                offlineSince = 0;
            } catch (error) {
                if (error.terminal || error.code === 'chatgpt_login_required') throw error;
                if (error.code === 'job_not_found') {
                    // The gateway restarted or its result retention elapsed.
                    submitted = false;
                    report({ stage: 'preparing', partialText: '', reasoningSummary: '', elapsedMs: 0 });
                } else if (error.code === 'not_found') {
                    throw gatewayError('codex_gateway_upgrade_required', 'Update and restart the private gateway to enable resumable lecture generation.');
                } else if (error.code === 'codex_gateway_network_error' || error.code === 'codex_gateway_stream_disconnected'
                    || error.code === 'codex_gateway_timeout' || error.name === 'AbortError'
                    || (error.status >= 502 && error.status <= 504)) {
                    lastNetworkError = error;
                    report({ stage: 'reconnecting', errorCode: error.code });
                    if (!offlineSince) offlineSince = Date.now();
                    if (++networkFailures >= 3 && Date.now() - offlineSince >= LECTURE_JOB_OFFLINE_GRACE_MS) {
                        throw gatewayError('codex_gateway_network_error',
                            'Cannot reach the gateway. The lecture job is retained; reopen it to resume. ' + error.message);
                    }
                } else {
                    throw error;
                }
            }
            if (job) {
                if (job.status === 'completed') return job;
                if (job.status === 'failed') {
                    throw gatewayError(job.error && job.error.code, job.error && job.error.message, job.error && job.error.status);
                }
                if (job.status !== 'pending') {
                    throw gatewayError('codex_gateway_response_invalid', 'The gateway returned an invalid lecture job status.');
                }
                if (job.progress) report(job.progress);
            }
            const delay = networkFailures ? Math.min(15000, 2000 * 2 ** (networkFailures - 1)) : 100;
            await new Promise((resolve, reject) => {
                const cleanup = () => options.signal?.removeEventListener('abort', cancel);
                const timer = setTimeout(() => { cleanup(); resolve(); }, delay);
                const cancel = () => { clearTimeout(timer); cleanup(); reject(gatewayError('codex_gateway_aborted', 'Stopped waiting for the lecture.')); };
                options.signal?.addEventListener('abort', cancel, { once: true });
                if (options.signal?.aborted) cancel();
            });
        }
        throw gatewayError('codex_gateway_timeout', lastNetworkError
            ? 'The gateway connection was lost. Reopen the lecture to retrieve its result.'
            : 'Stopped waiting for the lecture. Reopen it to retrieve its result.');
    }

    return {
        MAX_REQUEST_TIMEOUT_MS,
        DEVICE_LOGIN_URL,
        gatewayError,
        isLoopbackHostname,
        normalizeBaseUrl,
        hasAudioContent,
        serializeMessages,
        serializePdfAttachment,
        buildAskPayload,
        requestJson,
        readEventStream,
        reportProgress,
        getStatus,
        connectionState,
        startLogin,
        listModels,
        ask
    };
});

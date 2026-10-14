(function (root) {
    'use strict';

    const PREFIX = '__api_operation_v1__:';
    const active = new Map();
    const handlers = new Map();
    const recordWrites = new Map();
    let storage;
    let reportError = console.error;
    let recovering = false;

    function failure(code, message) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    async function fingerprint(value) {
        async function normalize(item) {
            if (item instanceof Blob) return { blob: await digest(await item.arrayBuffer()), type: item.type };
            if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
                const bytes = item instanceof ArrayBuffer ? item : new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
                return { bytes: await digest(bytes) };
            }
            if (Array.isArray(item)) return Promise.all(item.map(normalize));
            if (item && typeof item === 'object') {
                const result = {};
                for (const key of Object.keys(item).sort()) {
                    if (item[key] !== undefined && typeof item[key] !== 'function') result[key] = await normalize(item[key]);
                }
                return result;
            }
            return item;
        }
        return digest(new TextEncoder().encode(JSON.stringify(await normalize(value))));
    }

    async function digest(bytes) {
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    }

    function configure(adapter, onError) {
        storage = adapter;
        if (onError) reportError = onError;
    }

    function register(kind, handler) { handlers.set(kind, handler); }

    async function updateRecord(key, update) {
        const write = async () => {
            const value = await update(await storage.get(key));
            await storage.put(key, value);
            return value;
        };
        const previous = recordWrites.get(key) || Promise.resolve();
        const pending = previous.catch(() => {}).then(() => navigator.locks
            ? navigator.locks.request('math-reader-boox-codex:record:' + key, write) : write());
        recordWrites.set(key, pending);
        try { return await pending; }
        finally { if (recordWrites.get(key) === pending) recordWrites.delete(key); }
    }

    async function run(kind, identity, args, options = {}) {
        if (!storage) throw failure('AI_STORAGE_UNAVAILABLE', 'AI task storage is unavailable');
        const key = PREFIX + kind + ':' + await fingerprint(identity);
        if (active.has(key)) return active.get(key);
        const execute = async () => {
            let job = await storage.get(key);
            if (!job) {
                if (options.resume) return;
                job = { version: 1, id: crypto.randomUUID(), kind, identity, args, calls: {}, status: 'pending', createdAt: Date.now() };
            }
            if (options.resume && job.status === 'failed') return;
            // A user retry must be able to replace a syntactically invalid
            // answer. Keep partial continuations and successfully saved values.
            if (job.status === 'failed' && job.invalidResponse) {
                for (const id of Object.keys(job.calls)) {
                    if (job.calls[id].complete) delete job.calls[id];
                }
            }
            job.status = 'pending';
            delete job.error;
            await storage.put(key, job);
            let writes = Promise.resolve();
            const persist = () => {
                const snapshot = structuredClone(job);
                writes = writes.then(() => storage.put(key, snapshot));
                return writes;
            };
            const context = {
                id: job.id,
                recovering: !!options.resume,
                async value(name, create) {
                    job.values ||= {};
                    if (Object.prototype.hasOwnProperty.call(job.values, name)) return job.values[name];
                    const value = await create();
                    job.values[name] = value;
                    await persist();
                    return value;
                },
                async request(input, send) {
                    const id = await fingerprint(input);
                    const saved = job.calls[id];
                    if (saved?.complete) return saved.text;
                    const checkpoint = {
                        value: saved || {},
                        async save(value) {
                            this.value = value;
                            job.calls[id] = value;
                            await persist();
                        }
                    };
                    const text = await send(checkpoint);
                    await checkpoint.save({ complete: true, text });
                    return text;
                }
            };
            try {
                const handler = handlers.get(kind);
                if (!handler) throw failure('AI_TASK_UNSUPPORTED', 'Unknown AI task: ' + kind);
                const result = await handler(job.args, context);
                // The handler must finish the domain save before acknowledging.
                await writes;
                await storage.remove(key);
                return result;
            } catch (error) {
                job.status = error?.retryable || error?.name === 'NetworkError' ? 'pending' : 'failed';
                job.invalidResponse = /FORMAT_INVALID|PARSE_INVALID/.test(error?.code || '');
                job.error = String(error?.message || error);
                await persist().catch(reportError);
                throw error;
            }
        };
        const promise = (navigator.locks
            ? navigator.locks.request('math-reader-boox-codex:api:' + key, execute)
            : execute()).finally(() => active.delete(key));
        active.set(key, promise);
        return promise;
    }

    async function resume() {
        if (!storage || recovering || document.visibilityState === 'hidden' || navigator.onLine === false) return;
        recovering = true;
        try {
            const queue = (await storage.keys()).filter(key => String(key).startsWith(PREFIX));
            const worker = async () => { while (queue.length) {
                const key = queue.shift();
                if (!String(key).startsWith(PREFIX) || active.has(key)) continue;
                const job = await storage.get(key);
                if (!job || job.status !== 'pending' || !handlers.has(job.kind)) continue;
                try { await run(job.kind, job.identity, job.args, { resume: true }); }
                catch (error) { reportError(error); }
            } };
            await Promise.all([worker(), worker(), worker()]);
        } finally { recovering = false; }
    }

    function extract(provider, data) {
        let text, reason, complete, truncated;
        if (provider === 'gemini') {
            const candidate = data.candidates?.[0];
            text = (candidate?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
            reason = candidate?.finishReason;
            complete = reason === 'STOP';
            truncated = reason === 'MAX_TOKENS';
        } else if (provider === 'claude') {
            text = (data.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
            reason = data.stop_reason;
            complete = reason === 'end_turn' || reason === 'stop_sequence';
            truncated = reason === 'max_tokens';
        } else {
            text = data.choices?.[0]?.message?.content;
            reason = data.choices?.[0]?.finish_reason;
            complete = reason === 'stop';
            truncated = reason === 'length';
        }
        if (typeof text !== 'string') text = '';
        return { text, reason, complete, truncated };
    }

    async function complete(provider, body, send, options = {}) {
        const execute = async (checkpoint) => {
            let text = checkpoint?.value?.text || '';
            let passes = 0;
            while (passes++ < 8) {
                let request = body;
                if (text) {
                    const instruction = 'Continue the previous answer from its exact stopping point. Output only the missing continuation, with no repeated prefix, introduction, code fence, or extra comma. If it ended inside a JSON string, continue that string. Finish the entire requested answer.';
                    request = provider === 'gemini'
                        ? { ...body, contents: [...body.contents, { role: 'model', parts: [{ text }] }, { role: 'user', parts: [{ text: instruction }] }] }
                        : { ...body, messages: [...body.messages, { role: 'assistant', content: text }, { role: 'user', content: instruction }] };
                }
                const answer = extract(provider, await send(request));
                if (!answer.complete && !answer.truncated) {
                    throw failure('AI_INCOMPLETE_RESPONSE', options.incompleteMessage + (answer.reason ? ' (' + answer.reason + ')' : ''));
                }
                if (!answer.text.trim()) throw failure('AI_EMPTY_RESPONSE', options.emptyMessage);
                // Concatenate exact continuation bytes; never repair an unfinished
                // JSON value by cutting off its tail or inventing delimiters.
                text += answer.text;
                if (checkpoint) await checkpoint.save({ text, complete: answer.complete });
                if (answer.complete) return text;
            }
            throw failure('AI_INCOMPLETE_RESPONSE', options.incompleteMessage);
        };
        return options.apiTask
            ? options.apiTask.request({ provider, input: options.requestIdentity || body, connection: options.connection }, execute)
            : execute(null);
    }

    root.ApiRuntime = { configure, register, run, resume, updateRecord, fingerprint, failure, complete, active };
})(globalThis);

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { GatewayError, abortError } from './errors.mjs';

const FILES_URL = 'https://chatgpt.com/backend-api/files';
const INLINE_IMAGE_BUDGET = 1_000_000;

function uploadFailure(message, status = 502) {
  return new GatewayError('image_upload_failed', message, status);
}

// Follow Codex's ChatGPT file-upload protocol. Keep large page images out of
// response.create without changing their bytes or splitting the model turn.
export async function prepareImageUploads(input, config, { signal, fetchImpl = fetch } = {}) {
  const images = input.filter(item => item.type === 'localImage');
  if (!images.length) return input;
  const sizes = await Promise.all(images.map(async item => (await stat(item.path)).size));
  if (sizes.reduce((sum, size) => sum + 4 * Math.ceil(size / 3), 0) <= INLINE_IMAGE_BUDGET) {
    return input;
  }
  signal?.throwIfAborted();
  let tokens;
  try {
    ({ tokens } = JSON.parse(await readFile(join(config.codexHome, 'auth.json'), 'utf8')));
  } catch {
    throw uploadFailure('Could not read the isolated ChatGPT login for image upload.', 503);
  }
  if (!tokens?.access_token || !tokens?.account_id) {
    throw uploadFailure('A ChatGPT login is required to upload images.', 503);
  }
  const controller = new AbortController();
  const uploadSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    'ChatGPT-Account-ID': tokens.account_id,
    'Content-Type': 'application/json',
  };
  const send = async (url, options, timeoutMs = 60_000) => {
    uploadSignal.throwIfAborted();
    try {
      return await fetchImpl(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.any([uploadSignal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch {
      if (signal?.aborted) throw abortError(signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      // Signed blob URLs and login credentials must not enter public errors.
      throw uploadFailure('The image upload connection failed. Please retry.');
    }
  };
  const json = async (url, body, timeoutMs) => {
    const response = await send(url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
    if (!response.ok) {
      await response.body?.cancel();
      throw uploadFailure(`The image service rejected the upload (HTTP ${response.status}).`,
        response.status === 429 ? 429 : 502);
    }
    try {
      return await response.json();
    } catch {
      throw uploadFailure('The image service returned an invalid response.');
    }
  };
  const upload = async item => {
    const bytes = await readFile(item.path);
    const created = await json(FILES_URL, {
      file_name: basename(item.path), file_size: bytes.length, use_case: 'codex',
    });
    if (typeof created.file_id !== 'string' || !/^file[-_][A-Za-z0-9_-]+$/.test(created.file_id)) {
      throw uploadFailure('The image service did not return a valid file reference.');
    }
    let uploadUrl;
    try {
      uploadUrl = new URL(created.upload_url);
      if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password) throw new Error();
    } catch {
      throw uploadFailure('The image service did not return a secure upload address.');
    }
    // The signed storage URL supplies its own authorization; never forward the
    // ChatGPT bearer token to the storage host.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await send(uploadUrl, {
          method: 'PUT', body: bytes,
          headers: {
            'Content-Length': String(bytes.length),
            'x-ms-blob-type': 'BlockBlob',
            'x-ms-client-request-id': randomUUID(),
          },
        }, 300_000);
        await response.body?.cancel();
        if (!response.ok) throw uploadFailure(`Image storage rejected the upload (HTTP ${response.status}).`);
        break;
      } catch (error) {
        if (uploadSignal.aborted || attempt >= 2) throw error;
        await delay(500 * (attempt + 1), undefined, { signal: uploadSignal });
      }
    }
    const deadline = Date.now() + 30_000;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw uploadFailure('The uploaded image could not be finalized in time. Please retry.');
      const result = await json(`${FILES_URL}/${created.file_id}/uploaded`, {}, remainingMs);
      if (result.status === 'success') {
        return { type: 'image', fileId: created.file_id, detail: item.detail };
      }
      if (result.status !== 'retry' || Date.now() >= deadline) {
        throw uploadFailure('The uploaded image could not be finalized. Please retry.');
      }
      await delay(250, undefined, { signal: uploadSignal });
    }
  };
  const replacements = new Map();
  let next = 0;
  // Bound memory and concurrent blob transfers while preserving input order.
  const workers = Array.from({ length: Math.min(3, images.length) }, async () => {
    try {
      while (next < images.length) {
        const item = images[next++];
        replacements.set(item, await upload(item));
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  });
  await Promise.allSettled(workers);
  if (uploadSignal.aborted) {
    if (signal?.aborted) throw abortError(signal);
    throw controller.signal.reason;
  }
  return input.map(item => replacements.get(item) || item);
}

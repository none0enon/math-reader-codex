import { realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { GatewayError } from './errors.mjs';

const ALLOWED_ROLES = new Set(['assistant', 'developer', 'system', 'user']);
const IMAGE_TYPES = new Map([
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
const IMAGE_DETAILS = new Set(['auto', 'high', 'low', 'original']);
const ASK_FIELDS = new Set([
  'messages',
  'model',
  'pdfAttachment',
  'reasoningEffort',
  'systemPrompt',
]);

function invalid(message, code = 'invalid_request') {
  throw new GatewayError(code, message, 400);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value, name, maximum, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string') invalid(`${name} must be a string.`);
  if (value.length > maximum) invalid(`${name} is too long.`, 'request_too_large');
  return value;
}

function parseDataImage(value, label) {
  if (typeof value !== 'string') invalid(`${label} must contain a data URL string.`);
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) invalid(`${label} must be a base64 image data URL.`);
  const mimeType = match[1].toLowerCase();
  const extension = IMAGE_TYPES.get(mimeType);
  if (!extension) invalid(`${label} uses an unsupported image type.`);
  let bytes;
  try {
    bytes = Buffer.from(match[2], 'base64');
  } catch {
    invalid(`${label} contains invalid base64 data.`);
  }
  if (bytes.length === 0) invalid(`${label} is empty.`);
  if (bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
    invalid(`${label} contains invalid base64 data.`);
  }
  if (bytes.length > 24 * 1024 * 1024) {
    invalid(`${label} is larger than 24 MiB.`, 'request_too_large');
  }
  return { bytes, extension };
}

function normalizeBlock(block, messageIndex, blockIndex) {
  const label = `messages[${messageIndex}].content[${blockIndex}]`;
  if (!plainObject(block) || typeof block.type !== 'string') {
    invalid(`${label} must be a typed content block.`);
  }
  const normalizedType = block.type;
  if (normalizedType.includes('audio')) {
    invalid('Audio content is not supported by the private Codex gateway.', 'unsupported_audio');
  }
  if (normalizedType === 'text') {
    return {
      type: 'text',
      text: boundedString(block.text, `${label}.text`, 1_000_000),
    };
  }
  if (normalizedType === 'image_url') {
    const imageUrl =
      typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
    const detail = typeof block.image_url === 'object' ? block.image_url?.detail : undefined;
    if (detail !== undefined && !IMAGE_DETAILS.has(detail)) {
      invalid(`${label}.image_url.detail is invalid.`);
    }
    return {
      type: 'image',
      image: parseDataImage(imageUrl, `${label}.image_url`),
      detail: detail || null,
    };
  }
  invalid(`${label}.type is not supported.`);
}

function normalizeMessage(message, index) {
  if (!plainObject(message)) invalid(`messages[${index}] must be an object.`);
  if (!ALLOWED_ROLES.has(message.role)) {
    invalid(`messages[${index}].role must be user, assistant, system, or developer.`);
  }
  if (typeof message.content === 'string') {
    return {
      role: message.role,
      content: [{ type: 'text', text: boundedString(message.content, `messages[${index}].content`, 1_000_000) }],
    };
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    invalid(`messages[${index}].content must be a string or a non-empty array.`);
  }
  if (message.content.length > 128) invalid(`messages[${index}].content has too many blocks.`);
  return {
    role: message.role,
    content: message.content.map((block, blockIndex) => normalizeBlock(block, index, blockIndex)),
  };
}

export function validateAskBody(body) {
  if (!plainObject(body)) invalid('The request body must be a JSON object.');
  for (const field of Object.keys(body)) {
    if (!ASK_FIELDS.has(field)) invalid(`Unknown request field: ${field}.`);
  }
  const systemPrompt = boundedString(body.systemPrompt ?? '', 'systemPrompt', 1_000_000);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    invalid('messages must be a non-empty array.');
  }
  if (body.messages.length > 128) invalid('messages has too many entries.');
  const messages = body.messages.map(normalizeMessage);
  const model = boundedString(body.model, 'model', 200, { optional: true });
  const reasoningEffort = boundedString(body.reasoningEffort, 'reasoningEffort', 64, {
    optional: true,
  });

  let pdfAttachment;
  if (body.pdfAttachment !== undefined && body.pdfAttachment !== null) {
    if (!plainObject(body.pdfAttachment)) invalid('pdfAttachment must be an object.');
    const fields = Object.keys(body.pdfAttachment);
    if (fields.some((field) => field !== 'base64' && field !== 'name')) {
      invalid('pdfAttachment contains an unknown field.');
    }
    pdfAttachment = {
      base64: boundedString(body.pdfAttachment.base64, 'pdfAttachment.base64', 90_000_000),
      name: boundedString(body.pdfAttachment.name ?? 'attachment.pdf', 'pdfAttachment.name', 255),
    };
  }

  return { systemPrompt, messages, model, reasoningEffort, pdfAttachment };
}

async function materializeImage(image, directory, ordinal) {
  const path = join(directory, `input-${String(ordinal).padStart(4, '0')}.${image.extension}`);
  await writeFile(path, image.bytes, { mode: 0o600, flag: 'wx' });
  const canonicalDirectory = await realpath(directory);
  const canonicalPath = await realpath(path);
  const prefix = canonicalDirectory.endsWith(sep) ? canonicalDirectory : `${canonicalDirectory}${sep}`;
  if (!canonicalPath.startsWith(prefix)) {
    throw new GatewayError('invalid_image_path', 'An image escaped the request directory.', 500);
  }
  return canonicalPath;
}

export async function buildCodexInput(request, pdf, directory) {
  const input = [
    {
      type: 'text',
      text: 'BEGIN_APPLICATION_CONVERSATION\nEach message metadata and text block below is JSON encoded.',
    },
  ];
  let imageOrdinal = 0;
  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex];
    input.push({
      type: 'text',
      text: `MESSAGE_METADATA_JSON=${JSON.stringify({ index: messageIndex, role: message.role })}`,
    });
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex];
      if (block.type === 'text') {
        input.push({
          type: 'text',
          text: `MESSAGE_TEXT_BLOCK_JSON=${JSON.stringify({ blockIndex, text: block.text })}`,
        });
      } else {
        imageOrdinal += 1;
        const path = await materializeImage(block.image, directory, imageOrdinal);
        input.push({
          type: 'text',
          text: `MESSAGE_IMAGE_METADATA_JSON=${JSON.stringify({ blockIndex })}`,
        });
        input.push({ type: 'localImage', path, detail: block.detail });
      }
    }
    input.push({ type: 'text', text: 'END_MESSAGE' });
  }

  if (pdf) {
    input.push({
      type: 'text',
      text: `PDF_ATTACHMENT_METADATA_JSON=${JSON.stringify({
        name: request.pdfAttachment?.name || 'attachment.pdf',
        pageCount: pdf.pageCount,
      })}\nPDF_EXTRACTED_TEXT_JSON=${JSON.stringify(pdf.text || '')}`,
    });
    for (const image of pdf.images || []) {
      const absolutePath = resolve(image.path);
      const canonicalDirectory = await realpath(directory);
      const canonicalPath = await realpath(absolutePath);
      const prefix = canonicalDirectory.endsWith(sep) ? canonicalDirectory : `${canonicalDirectory}${sep}`;
      if (!canonicalPath.startsWith(prefix)) {
        throw new GatewayError(
          'invalid_pdf_image_path',
          'PDF rendering produced an image outside the request directory.',
          500,
        );
      }
      input.push({
        type: 'text',
        text: `PDF_PAGE_IMAGE_METADATA_JSON=${JSON.stringify({ page: image.page })}`,
      });
      input.push({ type: 'localImage', path: canonicalPath, detail: 'high' });
    }
  }
  input.push({
    type: 'text',
    text: 'END_APPLICATION_CONVERSATION\nReturn only the assistant response to the conversation.',
  });
  return input;
}

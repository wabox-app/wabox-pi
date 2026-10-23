// Image generation via OpenRouter or Pollinations AI.
//
// Runs in the daemon process so the sandboxed shell does not need network.
// Generated images are saved into the conversation media folder and can be
// sent with wabox_send.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import { readStoredCredential } from '@earendil-works/pi-coding-agent';

const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/images/generations';
const POLLINATIONS_URL = 'https://image.pollinations.ai/prompt';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5-image-mini';

function readPiCredential(providerId) {
  try {
    return readStoredCredential(providerId);
  } catch {
    return undefined;
  }
}

function credentialToken(credential) {
  if (!credential) return null;
  if (credential.type === 'oauth') return credential.access || null;
  if (credential.type === 'apiKey') return credential.key || credential.apiKey || null;
  return credential.access || credential.key || credential.apiKey || null;
}

async function resolveKey(config) {
  if (config.apiKey) return String(config.apiKey);
  if (config.apiKeyEnv && process.env[config.apiKeyEnv]) return String(process.env[config.apiKeyEnv]);
  if (config.apiKeyFile) {
    try {
      const text = await fs.readFile(config.apiKeyFile, 'utf8');
      const key = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (key) return key;
    } catch {
      // fall through
    }
  }
  if (config.usePiAuth !== false) {
    const token = credentialToken(readPiCredential(config.piProvider || 'openrouter'));
    if (token) return token;
  }
  return null;
}

function sanitizeFilename(base) {
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
}

function sizeFromDimensions(dimensions) {
  switch (dimensions) {
    case 'portrait': return '1024x1792';
    case 'landscape': return '1792x1024';
    case 'square':
    default: return '1024x1024';
  }
}

async function mkdirp(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

// ---- OpenRouter image generation ----

async function generateOpenRouter({ prompt, config, mediaDir, log, fetchImpl = fetch }) {
  const key = await resolveKey(config);
  if (!key) {
    throw new Error(
      'no image generation API key (set imageGen.apiKey/apiKeyEnv/apiKeyFile, or sign in to pi for the provider)',
    );
  }

  const model = config.model || DEFAULT_OPENROUTER_MODEL;
  const size = config.size || sizeFromDimensions(config.dimensions);
  const n = config.n || 1;

  const body = {
    model,
    prompt,
    n,
    size,
    response_format: 'b64_json',
  };

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs || 180_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    log?.info?.(`[image] generating with ${model}: ${prompt.slice(0, 100)}...`);
    const res = await fetchImpl(OPENROUTER_IMAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/wabox-app/wabox-pi',
        'X-Title': 'wabox-pi image generation',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`image generation ${res.status}: ${raw.trim().slice(0, 400)}`);
    }

    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`image generation returned invalid JSON: ${raw.slice(0, 200)}`);
    }

    if (value.error) {
      throw new Error(`image generation error: ${JSON.stringify(value.error).slice(0, 400)}`);
    }

    const imageData = value.data?.[0]?.b64_json || value.data?.[0]?.url;
    if (!imageData) {
      throw new Error(`no image returned in response: ${raw.slice(0, 300)}`);
    }

    let buffer;
    if (imageData.startsWith('http')) {
      // Fetch the image from URL
      const imgRes = await fetchImpl(imageData, { signal: controller.signal });
      if (!imgRes.ok) {
        throw new Error(`image fetch ${imgRes.status}`);
      }
      buffer = Buffer.from(await imgRes.arrayBuffer());
    } else {
      buffer = Buffer.from(imageData, 'base64');
    }

    const ext = '.png';
    const filename = `${Date.now()}-${sanitizeFilename(prompt.slice(0, 30))}${ext}`;
    const outPath = path.join(mediaDir, filename);
    await mkdirp(path.dirname(outPath));
    await fs.writeFile(outPath, buffer);

    log?.info?.(`[image] saved ${outPath} (${(buffer.length / 1024).toFixed(1)} KB)`);

    return { path: outPath, size: buffer.length, prompt, model };
  } catch (err) {
    if (err.name === 'AbortError') {
      log?.warn?.(`[image] timed out after ${timeoutMs}ms`);
      throw new Error(`image generation timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Pollinations AI (keyless fallback) ----

async function generatePollinations({ prompt, config, mediaDir, log, fetchImpl = fetch }) {
  const model = config.model || 'flux';
  const width = config.width || 1024;
  const height = config.height || 1024;
  const seed = config.seed || Math.floor(Math.random() * 1_000_000);

  const url = new URL(`${POLLINATIONS_URL}/${encodeURIComponent(prompt)}`);
  url.searchParams.set('width', String(width));
  url.searchParams.set('height', String(height));
  url.searchParams.set('seed', String(seed));
  url.searchParams.set('nologo', 'true');
  if (model !== 'flux') url.searchParams.set('model', model);

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs || 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    log?.info?.(`[image] generating via pollinations: ${prompt.slice(0, 100)}...`);
    const res = await fetchImpl(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`pollinations ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());

    const ext = '.jpg';
    const filename = `${Date.now()}-${sanitizeFilename(prompt.slice(0, 30))}${ext}`;
    const outPath = path.join(mediaDir, filename);
    await mkdirp(path.dirname(outPath));
    await fs.writeFile(outPath, buffer);

    log?.info?.(`[image] saved ${outPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return { path: outPath, size: buffer.length, prompt, model: `pollinations/${model}` };
  } catch (err) {
    if (err.name === 'AbortError') {
      log?.warn?.(`[image] timed out after ${timeoutMs}ms`);
      throw new Error(`image generation timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- dispatch ----

export async function generateImage({ prompt, config, mediaDir, log, fetchImpl = fetch }) {
  const provider = config.provider || 'openrouter';
  if (provider === 'pollinations') {
    return generatePollinations({ prompt, config, mediaDir, log, fetchImpl });
  }
  return generateOpenRouter({ prompt, config, mediaDir, log, fetchImpl });
}

// ---- tool ----

export function createGenerateImageTool({ config, turn, log, fetchImpl = globalThis.fetch }) {
  return {
    name: 'wabox_generate_image',
    label: 'Generate image',
    description:
      'Generate an image from a text description. ' +
      'The image is saved to the conversation media folder and can then be sent with wabox_send.',
    promptSnippet: 'Generate an image from a text prompt',
    promptGuidelines: [
      'Use wabox_generate_image when the user asks for a picture, illustration, diagram, or any visual.',
      'After generating, attach the returned file path in wabox_send to send it to the chat.',
      'Describe the image in detail for best results.',
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: 'Detailed text description of the desired image.',
      }),
      dimensions: Type.Optional(
        Type.Union(
          [
            Type.Literal('square'),
            Type.Literal('portrait'),
            Type.Literal('landscape'),
          ],
          { description: 'Preferred aspect ratio: square, portrait, or landscape' },
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      const imageGen = config.imageGen;
      if (!imageGen?.enabled && imageGen?.enabled !== undefined) {
        throw new Error('image generation is disabled in config');
      }
      if (!imageGen) {
        throw new Error('image generation is not configured');
      }

      const generationConfig = {
        ...imageGen,
        dimensions: params.dimensions || imageGen.dimensions || 'square',
      };

      const result = await generateImage({
        prompt: params.prompt,
        config: generationConfig,
        mediaDir: turn.mediaDir,
        log,
        fetchImpl,
      });

      return {
        content: [
          {
            type: 'text',
            text:
              `Image generated: ${path.basename(result.path)}\n` +
              `Local path: ${result.path}\n` +
              `Size: ${(result.size / 1024).toFixed(1)} KB\n` +
              `Model: ${result.model}\n` +
              `Send it to the user with wabox_send, using the file path above.`,
          },
        ],
        details: result,
      };
    },
  };
}

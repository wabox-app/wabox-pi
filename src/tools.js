// The one tool the agent uses to talk back. It writes an outbox job; wabox-core
// does the actual sending.
//
// `turn` is a mutable per-turn context shared with the conversation agent. Tool
// calls are serialized by pi within a turn, and turns are serialized by the
// runner, so there is no cross-talk.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import { writeJob } from './outbox.js';

export function createSendTool({ config, turn, log }) {
  return {
    name: 'wabox_send',
    label: 'Send WhatsApp message',
    description:
      'Send a WhatsApp reply in the current chat. Use this for text, for attaching files, and for emoji reactions. It quotes the incoming message by default.',
    promptSnippet: 'Send text, files, or a reaction to the current WhatsApp chat',
    promptGuidelines: [
      'Use wabox_send for every WhatsApp message, file attachment, and reaction.',
      'Do not repeat in your final assistant text anything already sent with wabox_send.',
    ],
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: 'Message text (WhatsApp markup, no Markdown)' })),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: 'File paths to attach. Relative paths resolve against your workspace.',
        }),
      ),
      react: Type.Optional(
        Type.Object({
          emoji: Type.String({ description: 'Single emoji; empty string removes a reaction' }),
          messageId: Type.Optional(
            Type.String({ description: 'Message to react to; defaults to the incoming message' }),
          ),
        }),
      ),
      quote: Type.Optional(
        Type.Boolean({ description: 'Quote the incoming message (default true)' }),
      ),
    }),

    async execute(_toolCallId, params) {
      const envelope = turn.envelope;
      if (!envelope) throw new Error('wabox_send called without an active inbound message');

      const text = typeof params.text === 'string' ? params.text : '';
      const trimmed = text.trim();
      const files = Array.isArray(params.files) ? params.files : [];

      if (!trimmed && files.length === 0 && !params.react) {
        throw new Error('nothing to send: provide text, files, or react');
      }

      const job = { to: envelope.from };

      if (params.quote !== false) {
        job.replyTo = {
          id: envelope.id,
          ...(envelope.participant ? { participant: envelope.participant } : {}),
        };
      }

      if (params.react) {
        job.react = {
          emoji: params.react.emoji ?? '',
          messageId: params.react.messageId || envelope.id,
          ...(envelope.participant ? { participant: envelope.participant } : {}),
        };
      }

      if (files.length) {
        const resolved = [];
        for (const file of files) {
          const abs = path.isAbsolute(file)
            ? path.normalize(file)
            : path.resolve(turn.workspace, file);
          try {
            await fs.access(abs);
          } catch {
            throw new Error(`file not found: ${file} (resolved to ${abs})`);
          }
          resolved.push(abs);
        }
        job.files = resolved;
      }

      if (trimmed) job.text = text;

      const target = await writeJob(config.outboxDir, job);
      if (trimmed || files.length) turn.sentContent = true;
      turn.sentAny = true;
      turn.sent.push(target);
      log?.debug(`queued outbox job ${path.basename(target)}`);

      const what = [
        trimmed ? 'text' : null,
        files.length ? `${files.length} file(s)` : null,
        params.react ? 'a reaction' : null,
      ]
        .filter(Boolean)
        .join(', ');
      return {
        content: [{ type: 'text', text: `Queued for WhatsApp: ${what}.` }],
        details: { job, file: target },
      };
    },
  };
}

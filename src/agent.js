// One pi session per WhatsApp conversation.
//
// Sessions are persisted per conversation and resumed on the next message, so
// the agent keeps context without us replaying history. Turns are serialized by
// the caller (ConversationRunner), which is also what makes the per-turn tool
// context safe.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { buildTaskPrompt, buildTurnPrompt } from './prompt.js';
import { systemPromptAppend } from './instructions.js';
import { createSendTool } from './tools.js';
import { createGenerateImageTool } from './generate_image.js';
import { proactiveJob, reactionJob, replyJob, writeJob } from './outbox.js';
import { HELP, parseLocalCommand, parseScheduleCommand } from './commands.js';
import { nextCronDate } from './cron.js';
import { formatJobs } from './schedule.js';
import { jobName, storedTask } from './tasks.js';
import { isAudio, transcribeFile, transcriptionConfigured } from './transcribe.js';
import { createFetchTool, createSearchTool } from './web.js';
import { describeImage, isImage, shouldDescribe, visionConfigured } from './vision.js';
import { fetchWithRetry } from './retry.js';
import { formatContext, formatUsage, summarizeUsage } from './usage.js';
import { resolveBashTool, workspaceJailExtension } from './jail.js';
import { readMemory, readSystemPrompt } from './workspace.js';

export class ConversationAgent {
  constructor({ config, log, slug, paths, jobs }) {
    this.config = config;
    this.log = log;
    this.slug = slug;
    this.paths = paths;
    this.jobs = jobs ?? null;
    this.session = null;
    this.modelRuntime = null;
    this.modelFallbackMessage = null;
    this.lastCompactWarn = 0;
    this.turnTimedOut = false;
    this.lastUsed = Date.now();
    this.lastModelError = null;
    this.turns = 0;
    this.turn = {
      envelope: null,
      workspace: paths.workspace,
      sentContent: false,
      sentAny: false,
      sent: [],
      proactive: false,
    };
  }

  // One retrying fetch for every external API this agent calls (image
  // generation, web tools, transcription). Created lazily so an agent that
  // never leaves the process pays nothing.
  resilientFetch() {
    this.fetchImpl ??= fetchWithRetry(globalThis.fetch, {
      maxAttempts: this.config.apiRetryMaxAttempts,
      initialDelayMs: this.config.apiRetryInitialDelayMs,
      maxDelayMs: this.config.apiRetryMaxDelayMs,
      multiplier: this.config.apiRetryMultiplier,
      onRetry: ({ attempt, delay, error }) => {
        this.log.warn(
          `[${this.slug}] API retry ${attempt}/${this.config.apiRetryMaxAttempts} in ${delay}ms: ${error.message}`,
        );
      },
    });
    return this.fetchImpl;
  }

  async ensureSession() {
    if (this.session) return this.session;

    const jailed = this.config.jail;
    const resilientFetch = this.resilientFetch();

    // Resolve bash first: in "bwrap" mode a missing bubblewrap throws here,
    // before a session is created with an unsandboxed shell.
    const customTools = [createSendTool({ config: this.config, turn: this.turn, log: this.log })];
    if (this.config.imageGen && this.config.imageGen.enabled !== false) {
      customTools.push(createGenerateImageTool({ config: this.config, turn: this.turn, log: this.log, fetchImpl: resilientFetch }));
    }
    const bashTool = resolveBashTool({
      config: this.config,
      workspace: this.paths.workspace,
      log: this.log,
      // Inbound attachments live outside the workspace; expose them read-only
      // so the agent can copy one into the vault (the media folder itself
      // stays read-only inside the sandbox).
      readRoots: [this.paths.media],
    });
    if (bashTool) customTools.push(bashTool);
    const sandboxedBash = Boolean(bashTool);

    // Web access runs in this process, not the sandboxed shell.
    const webFetch = Boolean(this.config.web?.fetch?.enabled);
    const webSearch = Boolean(this.config.web?.search?.enabled);
    if (webFetch) customTools.push(createFetchTool({ config: this.config, log: this.log, fetchImpl: resilientFetch }));
    if (webSearch) customTools.push(createSearchTool({ config: this.config, log: this.log, fetchImpl: resilientFetch }));

    const memory = readMemory(this.paths.workspace);
    if (memory) {
      this.log.debug(`[${this.slug}] loaded MEMORY.md (${memory.length} chars)`);
    }

    // System prompt layering: pi's base prompt -> harness WhatsApp rules ->
    // the operator's inline override -> the workspace SYSTEM.md file. The file
    // is edited from the dashboard (or by hand) and read once per session.
    const systemPromptFile = readSystemPrompt(this.paths.workspace);
    const systemPromptInline = this.config.systemPrompt?.trim() || null;
    const extraSystemPrompt = [systemPromptInline, systemPromptFile].filter(Boolean).join('\n\n');

    const loader = new DefaultResourceLoader({
      cwd: this.paths.workspace,
      agentDir: getAgentDir(),
      ...(jailed
        ? {
            extensionFactories: [
              workspaceJailExtension({
                workspace: this.paths.workspace,
                // Inbound media lives outside the workspace; the model needs to
                // read attachments the harness already saved there.
                readRoots: [this.paths.media],
                log: this.log,
              }),
            ],
          }
        : {}),
      appendSystemPromptOverride: (base) => [
        ...base,
        systemPromptAppend({
          workspace: this.paths.workspace,
          jailed,
          sandboxedBash,
          web: { fetch: webFetch, search: webSearch },
          imageGen: Boolean(this.config.imageGen?.enabled !== false),
          memory,
          imagesDescribed: visionConfigured(this.config.vision),
        }),
        ...(extraSystemPrompt ? [extraSystemPrompt] : []),
      ],
    });
    await loader.reload();

    const sessionManager = SessionManager.continueRecent(
      this.paths.workspace,
      this.paths.sessions,
    );

    const desired = await this.desiredModel();
    const thinkingLevel = this.config.thinkingLevel ?? desired?.thinkingLevel;

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.paths.workspace,
      sessionManager,
      resourceLoader: loader,
      tools: [...new Set([...this.config.tools, ...customTools.map((tool) => tool.name)])],
      ...(this.config.excludeTools.length ? { excludeTools: this.config.excludeTools } : {}),
      ...(desired ? { model: desired.model, modelRuntime: desired.runtime } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      customTools,
    });

    this.modelFallbackMessage = modelFallbackMessage;
    if (modelFallbackMessage) this.log.warn(modelFallbackMessage);

    session.subscribe((event) => {
      // Keep the log useful without dumping streamed text.
      if (event.type === 'tool_execution_start') {
        this.log.debug(`[${this.slug}] tool ${event.toolName}`);
      } else if (event.type === 'message_end') {
        const message = event.message;
        if (message?.role === 'assistant' && message.stopReason === 'error') {
          const errorMsg = message.errorMessage || message.error || 'unknown error';
          this.log.warn(`[${this.slug}] assistant stopped with an error: ${errorMsg}`);
          this.lastModelError = errorMsg;
        }
      }
    });

    this.session = session;
    this.log.info(
      `[${this.slug}] session ready (${session.sessionId}, model ${session.model?.id ?? 'default'})`,
    );
    return session;
  }

  // Token and context accounting for the log line of a turn.
  usageSuffix(session, fromIndex = 0) {
    if (this.config.logTokens === false) return '';
    try {
      const usage = summarizeUsage(session.messages, fromIndex);
      const context = session.getContextUsage?.() ?? null;
      return ` | ${formatUsage(usage)} | ${formatContext(context)}`;
    } catch (err) {
      return ` | usage unavailable (${err?.message || err})`;
    }
  }

  // Estimated context size of the session, in tokens.
  contextTokens(session) {
    const messages = session?.messages ?? [];
    return messages.reduce((total, message) => total + estimateTokens(message), 0);
  }

  // pi only compacts when the context approaches the model's window, which is
  // far too late for a long-lived chat: every request re-sends the whole
  // history, so turns get slower and slower. Compact at a share of the window.
  async maybeCompact(session) {
    const ratio = this.config.contextCompactRatio;
    const window = session?.model?.contextWindow ?? 0;
    const tokens = this.contextTokens(session);

    if (tokens >= (this.config.contextCompactWarnTokens ?? 0)) {
      this.log.warn(
        `[${this.slug}] context is ~${Math.round(tokens / 1000)}k tokens` +
          `${this.lastCompactWarn === tokens ? '' : ' (/new clears it)'}`,
      );
      this.lastCompactWarn = tokens;
    }

    if (!ratio || !window) return;
    if (tokens < window * ratio) return;

    this.log.info(`[${this.slug}] compacting context (~${Math.round(tokens / 1000)}k tokens)`);
    try {
      await session.compact();
      this.log.info(`[${this.slug}] compacted, context now ~${Math.round(this.contextTokens(session) / 1000)}k tokens`);
    } catch (err) {
      this.log.warn(`[${this.slug}] compaction failed: ${err?.message || err}`);
    }
  }

  // React to the inbound message when a turn takes long, so the chat is not
  // left wondering whether the agent is alive.
  startTurnFeedback(envelope) {
    const delay = this.config.turnFeedbackMs ?? 0;
    if (!delay) return { clear() {} };
    const timer = setTimeout(() => {
      const emoji = this.config.turnFeedbackReact || '⏳';
      writeJob(this.config.outboxDir, reactionJob(envelope, emoji)).catch((err) => {
        this.log.warn(`[${this.slug}] turn feedback reaction failed: ${err.message}`);
      });
    }, delay);
    timer.unref?.();
    return {
      clear() {
        clearTimeout(timer);
      },
    };
  }

  // Abort a turn that runs too long, so the conversation queue is not blocked
  // forever and the user gets an answer.
  startTurnTimeout(session, envelope) {
    const limit = this.config.turnTimeoutMs ?? 0;
    if (!limit) return { clear() {} };
    const timer = setTimeout(() => {
      this.log.warn(`[${this.slug}] turn exceeded ${limit}ms, aborting`);
      this.turnTimedOut = true;
      session.abort().catch(() => {});
    }, limit);
    timer.unref?.();
    return {
      clear() {
        clearTimeout(timer);
      },
    };
  }

  // Resolve the per-conversation model override (config.modelProvider/model)
  // against pi's model catalog. Returns null to keep pi's default selection.
  async desiredModel() {
    const provider = this.config.modelProvider || undefined;
    const modelId = this.config.model || undefined;
    if (!provider && !modelId) return null;

    this.modelRuntime ??= await ModelRuntime.create();
    const resolved = resolveCliModel({
      cliProvider: provider,
      cliModel: modelId,
      modelRuntime: this.modelRuntime,
    });
    if (resolved.error) {
      this.log.warn(`[${this.slug}] model override ignored: ${resolved.error}`);
      return null;
    }
    if (resolved.warning) this.log.warn(`[${this.slug}] model: ${resolved.warning}`);
    return { model: resolved.model, thinkingLevel: resolved.thinkingLevel, runtime: this.modelRuntime };
  }

  async handleBatch(envelopes) {
    if (!envelopes.length) return;
    this.lastUsed = Date.now();
    this.turns += 1;

    const current = envelopes[envelopes.length - 1];

    // Local commands: answer without touching the agent session.
    if (envelopes.length === 1) {
      const command = parseLocalCommand(current.text);
      if (command) {
        await this.runCommand(command, current);
        return;
      }
    }

    this.turn.envelope = current;
    this.turn.workspace = this.paths.workspace;
    this.turn.mediaDir = this.paths.media;
    this.turn.sentContent = false;
    this.turn.sentAny = false;
    this.turn.sent = [];
    this.turn.proactive = false;
    this.turnTimedOut = false;

    try {
      let expandPromptTemplates = false;
      if (envelopes.length === 1 && /^\//.test((current.text || '').trim())) {
        // Not ours: let pi handle its own slash commands (/compact, skills, …).
        expandPromptTemplates = true;
      }

      await this.transcribeBatch(envelopes);

      const session = await this.ensureSession();
      await this.describeImages(session, envelopes);
      await this.maybeCompact(session);
      const prompt = buildTurnPrompt(envelopes);
      const started = Date.now();

      const feedback = this.startTurnFeedback(current);
      const timeout = this.startTurnTimeout(session, current);
      const usageFrom = session.messages.length;

      try {
        await session.prompt(prompt, { expandPromptTemplates });
      } catch (err) {
        this.log.error(`[${this.slug}] turn failed: ${err?.message || err}`);
        // A broken session must not poison every later message.
        this.disposeSession();
        await this.reportError(current, err);
        throw err;
      } finally {
        feedback.clear();
        timeout.clear();
      }

      const text = session.getLastAssistantText()?.trim() || '';
      if (this.turnTimedOut) {
        // The turn was cut short: say so instead of sending a half answer.
        if (!this.turn.sentContent) {
          await writeJob(
            this.config.outboxDir,
            replyJob(current, {
              text: '⏱️ Isso demorou demais e eu interrompi. Manda de novo que eu continuo daqui.',
            }),
          );
        }
      } else if (!this.turn.sentContent && this.lastModelError) {
        // The model produced no output because it errored (e.g. rate limit,
        // provider outage). Tell the user instead of staying silent.
        await writeJob(
          this.config.outboxDir,
          replyJob(current, {
            text: `⚠️ O modelo falhou: ${this.lastModelError}. Tente novamente ou mude de modelo com /model.`,
          }),
        );
        this.lastModelError = null;
      } else if (!this.turn.sentContent && this.config.autoReply && text) {
        await writeJob(this.config.outboxDir, replyJob(current, { text }));
      }

      const ms = Date.now() - started;
      this.log.info(
        `[${this.slug}] turn done in ${ms}ms (${this.turn.sent.length} outbox job(s)` +
          `${this.turn.sentContent ? '' : ', auto-reply'})` +
          this.usageSuffix(session, usageFrom),
      );
    } finally {
      // No tool call may outlive the turn that supplied its target.
      this.turn.envelope = null;
    }
  }

  // Transcribe inbound audio before the turn. Doing it here (per conversation)
  // rather than at claim time keeps a slow network call from blocking other
  // chats' inbox files.
  async transcribeBatch(envelopes) {
    const config = this.config.transcription;
    if (!transcriptionConfigured(config)) return;

    for (const envelope of envelopes) {
      const media = envelope.media;
      if (!media?.localPath || media.error) continue;
      if (media.transcript || media.transcriptError) continue;
      if (!isAudio(media)) continue;

      try {
        const { text, model } = await transcribeFile({
          config,
          filePath: media.localPath,
          log: this.log,
          fetchImpl: this.resilientFetch(),
        });
        envelope.media = { ...media, transcript: text, transcriptModel: model };
        await fs
          .writeFile(`${media.localPath}.txt`, `${text}\n`)
          .catch((err) => this.log.warn(`[${this.slug}] transcript sidecar failed: ${err.message}`));
        this.log.info(`[${this.slug}] transcribed ${path.basename(media.localPath)} (${model})`);
      } catch (err) {
        envelope.media = { ...media, transcriptError: err.message };
        this.log.warn(`[${this.slug}] transcription failed: ${err.message}`);
      }
    }
  }

  // The chat model may be text-only. Describe inbound images with the
  // configured vision model before the turn, so the prompt carries text the
  // model can actually use. Runs per conversation (like transcription) so a
  // slow vision call does not hold up the inbox claim chain.
  async describeImages(session, envelopes) {
    const vision = this.config.vision;
    if (!visionConfigured(vision)) return;
    if (!shouldDescribe({ vision, model: session?.model })) return;

    for (const envelope of envelopes) {
      const media = envelope.media;
      if (!media?.localPath || media.error) continue;
      if (!isImage(media)) continue;
      if (media.description || media.descriptionError) continue;

      try {
        const { text, model } = await describeImage({
          vision,
          filePath: media.localPath,
          media,
          log: this.log,
        });
        envelope.media = { ...media, description: text, descriptionModel: model };
        if (vision.writeSidecar !== false) {
          await fs
            .writeFile(`${media.localPath}.description.txt`, `${text}\n`)
            .catch((err) =>
              this.log.warn(`[${this.slug}] description sidecar failed: ${err.message}`),
            );
        }
        this.log.info(`[${this.slug}] described ${path.basename(media.localPath)} (${model})`);
      } catch (err) {
        envelope.media = { ...media, descriptionError: err.message };
        this.log.warn(`[${this.slug}] image description failed: ${err.message}`);
      }
    }
  }

  async reportError(envelope, err, { proactive = false } = {}) {
    if (!this.config.errorReply) return;
    // Keep details out of the chat: error text can contain local paths or
    // provider internals. The operator has the log.
    this.log.error(`[${this.slug}] turn error detail: ${String(err?.message || err)}`);
    const text = proactive
      ? '⚠️ A scheduled task failed. The operator can check the wabox-pi log.'
      : '⚠️ I could not process that message. The operator can check the wabox-pi log.';
    try {
      await writeJob(
        this.config.outboxDir,
        proactive ? proactiveJob(envelope, { text }) : replyJob(envelope, { text }),
      );
    } catch (writeErr) {
      this.log.error(`[${this.slug}] could not send error reply: ${writeErr.message}`);
    }
  }

  // A scheduled task: run one turn against a synthetic target so tools can
  // reach the chat, but mark it proactive so nothing quotes a nonexistent
  // message. Turns stay serialized by the runner.
  async runTask(task, identity) {
    this.lastUsed = Date.now();
    this.turns += 1;

    this.turn.envelope = {
      id: null,
      from: identity.from,
      participant: identity.participant ?? null,
      pushName: identity.pushName ?? null,
      number: identity.number ?? null,
    };
    this.turn.workspace = this.paths.workspace;
    this.turn.mediaDir = this.paths.media;
    this.turn.sentContent = false;
    this.turn.sentAny = false;
    this.turn.sent = [];
    this.turn.proactive = true;

    const started = Date.now();
    try {
      const session = await this.ensureSession();
      const usageFrom = session.messages.length;
      await session.prompt(buildTaskPrompt(task));
      const text = session.getLastAssistantText()?.trim() || '';
      // A silent task only sends what it explicitly passes to wabox_send.
      if (!this.turn.sentContent && !task.silent && this.config.autoReply && text) {
        await writeJob(this.config.outboxDir, proactiveJob(this.turn.envelope, { text }));
      }
      this.log.info(
        `[${this.slug}] task "${task.name}" done in ${Date.now() - started}ms ` +
          `(${this.turn.sent.length} outbox job(s)${this.turn.sentContent ? '' : ', auto-reply'})` +
          this.usageSuffix(session, usageFrom),
      );
    } catch (err) {
      this.log.error(`[${this.slug}] task "${task.name}" failed: ${err?.message || err}`);
      this.disposeSession();
      // A silent task must not spam the chat on failure; the log has it.
      if (!task.silent) await this.reportError(this.turn.envelope, err, { proactive: true });
      throw err;
    } finally {
      this.turn.envelope = null;
      this.turn.proactive = false;
    }
  }

  async runCommand(command, envelope) {
    let reply;
    switch (command.name) {
      case 'ping':
        reply = 'pong';
        break;
      case 'help':
        reply = HELP;
        break;
      case 'status':
        reply = await this.statusText();
        break;
      case 'tasks':
      case 'jobs':
        reply = await this.jobsText();
        break;
      case 'model':
        reply = this.modelText();
        break;
      case 'schedule':
        reply = await this.scheduleJob(command.args, envelope);
        break;
      case 'unschedule':
      case 'cancel':
        reply = await this.unscheduleJob(command.args);
        break;
      case 'new':
      case 'reset':
      case 'clear':
        await this.reset();
        reply = 'Started a new session. Previous context cleared.';
        break;
      case 'memory':
        reply = await this.memoryText(command.args);
        break;
      default:
        reply = HELP;
    }
    await writeJob(this.config.outboxDir, replyJob(envelope, { text: reply }));
    this.log.info(`[${this.slug}] local command /${command.name}`);
  }

  async statusText() {
    const lines = ['*wabox-pi status*'];
    lines.push(`chat: ${this.slug}`);
    lines.push(`turns: ${this.turns}`);
    lines.push(`workspace: ${this.paths.workspace}`);
    if (this.session) {
      lines.push(`session: ${this.session.sessionId}`);
      lines.push(`model: ${this.session.model?.provider ?? '?'}/${this.session.model?.id ?? '?'}`);
      if (this.session.sessionFile) lines.push(`session file: ${this.session.sessionFile}`);
    } else {
      lines.push('session: not started');
    }
    if (this.config.modelProvider || this.config.model) {
      lines.push(`model override: ${this.config.modelProvider ?? '?'}/${this.config.model ?? '?'}`);
    }
    if (this.session) {
      const tokens = this.contextTokens(this.session);
      lines.push(`context: ~${Math.round(tokens / 1000)}k tokens`);
      const totals = summarizeUsage(this.session.messages, 0);
      if (totals.requests) {
        lines.push(
          `tokens: in ${totals.input} out ${totals.output} total ${totals.total} ` +
            `(${totals.requests} requests, $${totals.cost.toFixed(4)})`,
        );
      }
    }
    if (this.config.thinkingLevel) lines.push(`thinking: ${this.config.thinkingLevel}`);
    if (this.modelFallbackMessage) lines.push(`note: ${this.modelFallbackMessage}`);
    return lines.join('\n');
  }

  modelText() {
    const lines = ['*Model*'];
    const configured =
      this.config.modelProvider || this.config.model
        ? `${this.config.modelProvider ?? '?'}/${this.config.model ?? '?'}`
        : '(pi default)';
    lines.push(`configured: ${configured}`);
    if (this.config.thinkingLevel) lines.push(`thinking: ${this.config.thinkingLevel}`);
    lines.push(
      this.session?.model
        ? `active: ${this.session.model.provider}/${this.session.model.id}`
        : 'active: not started',
    );
    return lines.join('\n');
  }

  async memoryText(args) {
    const file = path.join(this.paths.workspace, 'MEMORY.md');
    const action = (args || '').trim().toLowerCase();
    if (action === 'clear' || action === 'reset') {
      try {
        await fs.rm(file, { force: true });
        return 'MEMORY.md cleared. I will no longer see stored facts on new sessions.';
      } catch (err) {
        return `Could not clear memory: ${err.message}`;
      }
    }
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      return 'No MEMORY.md yet. I remember durable facts when you ask me to write them into MEMORY.md.';
    }
    return `*MEMORY.md*\n\n${content.trim()}`;
  }

  async jobsText() {
    if (!this.jobs) return 'Job management is not available.';
    return formatJobs(await this.jobs.list(), { slug: this.slug });
  }

  async scheduleJob(args, envelope) {
    if (!this.jobs) return 'Job management is not available.';
    const parsed = parseScheduleCommand(args);
    if (parsed.error) return parsed.error;

    const existing = new Set((await this.jobs.list()).map((task) => task.name));
    const raw = storedTask({
      name: jobName(parsed.prompt, existing),
      slug: this.slug,
      to: envelope.from,
      participant: envelope.participant ?? null,
      cron: parsed.cron,
      timezone: this.config.timezone,
      prompt: parsed.prompt,
      enabled: true,
    });

    let created;
    try {
      created = await this.jobs.add(raw);
    } catch (err) {
      return `Could not schedule: ${err.message}`;
    }
    const next = created.parsed ? nextCronDate(created.parsed, new Date(), created.timezone) : null;
    return (
      `Job *${created.name}* scheduled: ${created.cron}` +
      `${created.timezone ? ` (${created.timezone})` : ''}` +
      `${next ? `\nNext: ${next.toISOString()}` : ''}\n` +
      `Remove with /unschedule ${created.name}`
    );
  }

  async unscheduleJob(args) {
    if (!this.jobs) return 'Job management is not available.';
    const name = (args || '').trim().split(/\s+/)[0];
    if (!name) return 'Usage: /unschedule <name> (see /jobs)';
    let removed;
    try {
      removed = await this.jobs.remove(name);
    } catch (err) {
      return `Could not remove: ${err.message}`;
    }
    if (removed) return `Job "${name}" removed.`;
    return `No chat-scheduled job named "${name}". Config jobs must be removed from config.json.`;
  }

  status() {
    return {
      slug: this.slug,
      turns: this.turns,
      lastUsed: new Date(this.lastUsed).toISOString(),
      sessionId: this.session?.sessionId ?? null,
      sessionFile: this.session?.sessionFile ?? null,
      model: this.session?.model
        ? `${this.session.model.provider}/${this.session.model.id}`
        : null,
      workspace: this.paths.workspace,
    };
  }

  // /new: drop the active branch *and* its history. The workspace/media stay.
  async reset() {
    this.disposeSession();
    const files = await fs.readdir(this.paths.sessions).catch(() => []);
    await Promise.all(
      files
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => fs.rm(path.join(this.paths.sessions, name), { force: true })),
    );
    this.turns = 0;
    this.modelFallbackMessage = null;
  }

  disposeSession() {
    if (!this.session) return;
    try {
      this.session.dispose();
    } catch (err) {
      this.log.warn(`[${this.slug}] session dispose failed: ${err?.message || err}`);
    }
    this.session = null;
  }

  async dispose() {
    this.disposeSession();
  }
}

// Programmatic entry point. The CLI uses these; embedding hosts can too.

export { startDaemon } from './daemon.js';
export { loadConfig } from './config.js';
export { ConversationAgent } from './agent.js';
export { buildTurnPrompt } from './prompt.js';
export { writeJob, replyJob, reactionJob } from './outbox.js';
export { VERSION } from './version.js';

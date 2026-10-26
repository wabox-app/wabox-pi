import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { startDashboard } from './dashboard.js';
import { createLogger } from './logger.js';
import { acquireLock } from './lock.js';
import { startDaemon } from './daemon.js';
import { nextCronDate } from './cron.js';
import { normalizeTasks } from './schedule.js';
import { transcriptionLabel } from './transcribe.js';
import { APP, VERSION } from './version.js';

async function dynamicTasks(config) {
  try {
    const value = JSON.parse(await fs.readFile(config.tasksFile, 'utf8'));
    const list = Array.isArray(value) ? value : value?.tasks;
    return normalizeTasks(Array.isArray(list) ? list : [], { timezone: config.timezone });
  } catch {
    return [];
  }
}

function usage() {
  console.log(`${APP} ${VERSION} — connect WhatsApp conversations to pi

Usage:
  ${APP} run            Run the harness (default)
  ${APP} run --dashboard  Run the harness plus the management dashboard
  ${APP} dashboard      Serve the dashboard (reads state; no WhatsApp loop)
  ${APP} status         Show resolved paths and local state
  ${APP} status --json  Same, machine-readable
  ${APP} version        Print the version
  ${APP} help           This message

wabox-pi watches wabox-core's inbox and answers through its outbox. It does not
connect to WhatsApp itself; run \`wabox run\` (or its service) for that.

Environment:
  WABOX_INBOX / WABOX_OUTBOX       override the folders
  WABOX_PI_STATE_DIR               harness state (sessions, workspaces, log)
  WABOX_PI_CONFIG                  config.json path
  WABOX_PI_LOG_LEVEL               debug | info | warn | error
  WABOX_PI_BATCH_MS                coalesce a message burst for this long
  WABOX_PI_ACK_REACT               emoji to react with on pickup
  WABOX_PI_AUTO_REPLY              0 to disable sending final text
  WABOX_PI_ERROR_REPLY             0 to stay silent when a turn fails
  WABOX_PI_GROUP_PER_PARTICIPANT   1 to give each group sender their own session
  WABOX_PI_TOOLS                   comma-separated pi tool allowlist
  WABOX_PI_TIMEZONE                default IANA zone for scheduled tasks
  WABOX_PI_SANDBOX_BASH            off | auto | bwrap (required)
  WABOX_PI_DASHBOARD_HOST          dashboard bind address (default 127.0.0.1)
  WABOX_PI_DASHBOARD_PORT          dashboard port (0/empty disables it)
  WABOX_PI_DASHBOARD_TOKEN         bearer token, required off-loopback
`);
}

async function listDir(dir, suffix) {
  try {
    return (await fs.readdir(dir)).filter((name) => !suffix || name.endsWith(suffix));
  } catch {
    return [];
  }
}

async function lockOwner(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    const pid = Number.parseInt(text, 10);
    try {
      process.kill(pid, 0);
      return { pid, alive: true };
    } catch {
      return { pid, alive: false };
    }
  } catch {
    return null;
  }
}

async function status(asJson) {
  const config = loadConfig();
  const conversationsDir = config.conversationsDir;
  const conversations = await listDir(conversationsDir);
  const lock = await lockOwner(config.lockFile);
  const allTasks = [...config.tasks, ...(await dynamicTasks(config))];

  const data = {
    version: VERSION,
    running: !!lock?.alive,
    pid: lock?.alive ? lock.pid : null,
    paths: {
      inbox: config.inboxDir,
      outbox: config.outboxDir,
      state: config.stateDir,
      log: config.logFile,
      sessions: conversationsDir,
      config: config.configFile,
    },
    dashboard: config.dashboardPort
      ? {
          host: config.dashboardHost,
          port: config.dashboardPort,
          url: `http://${config.dashboardHost}:${config.dashboardPort}`,
        }
      : null,
    conversations: [],
    tasks: allTasks.map((task) => ({
      name: task.name,
      enabled: task.enabled,
      cron: task.cron,
      timezone: task.timezone,
      source: task.source,
      target: task.slug || task.to || null,
      error: task.error || null,
      next:
        task.parsed && task.enabled
          ? nextCronDate(task.parsed, new Date(), task.timezone)?.toISOString() ?? null
          : null,
    })),
    settings: {
      batchWindowMs: config.batchWindowMs,
      ackReact: config.ackReact,
      autoReply: config.autoReply,
      groupPerParticipant: config.groupPerParticipant,
      tools: config.tools,
      excludeTools: config.excludeTools,
      transcription: transcriptionLabel(config.transcription),
      web: {
        fetch: Boolean(config.web?.fetch?.enabled),
        search: config.web?.search?.enabled ? config.web.search.provider : false,
      },
    },
  };

  for (const slug of conversations) {
    const root = path.join(conversationsDir, slug);
    const sessions = await listDir(path.join(root, 'sessions'), '.jsonl');
    const processed = await listDir(path.join(root, 'processed'), '.json');
    data.conversations.push({
      slug,
      workspace: path.join(root, 'workspace'),
      sessions: sessions.length,
      latestSession: sessions.sort().at(-1) || null,
      processed: processed.length,
    });
  }

  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`${APP} ${VERSION}${data.running ? ` (running, pid ${lock.pid})` : ' (not running)'}`);
  console.log('');
  console.log('Paths:');
  console.log(`  inbox   : ${config.inboxDir}`);
  console.log(`  outbox  : ${config.outboxDir}`);
  console.log(`  state   : ${config.stateDir}`);
  console.log(`  log     : ${config.logFile}`);
  if (config.configFile) console.log(`  config  : ${config.configFile}`);
  if (data.dashboard) console.log(`  dashboard: ${data.dashboard.url}`);
  console.log('');
  console.log(`Conversations: ${data.conversations.length}`);
  for (const conv of data.conversations.slice(0, 20)) {
    console.log(
      `  ${conv.slug}  sessions=${conv.sessions}  processed=${conv.processed}`,
    );
  }
  console.log('');
  if (data.tasks.length) {
    console.log('Scheduled jobs:');
    for (const task of data.tasks) {
      const flags = [
        task.enabled ? 'on' : 'off',
        task.source === 'chat' ? '(chat)' : '',
        `${task.cron}${task.timezone ? ` ${task.timezone}` : ''}`,
        task.error ? `ERROR: ${task.error}` : `next ${task.next ?? 'never'}`,
        task.target ?? '',
      ].filter(Boolean);
      console.log(`  ${task.name.padEnd(20)} ${flags.join('  ')}`);
    }
    console.log('');
  }
  console.log('Settings:');
  console.log(`  autoReply           : ${config.autoReply}`);
  console.log(`  batchWindowMs       : ${config.batchWindowMs}`);
  console.log(`  ackReact            : ${config.ackReact || '(none)'}`);
  console.log(`  groupPerParticipant : ${config.groupPerParticipant}`);
  console.log(`  tools               : ${config.tools.join(', ')}`);
  console.log(`  transcription       : ${transcriptionLabel(config.transcription)}`);
  console.log(
    `  web                 : fetch=${config.web?.fetch?.enabled ? 'on' : 'off'}` +
      ` search=${config.web?.search?.enabled ? config.web.search.provider : 'off'}`,
  );
}

async function run({ dashboard: withDashboard = false } = {}) {
  const config = loadConfig();
  if (withDashboard && !config.dashboardPort) config.dashboardPort = 7345;
  const log = createLogger({ level: config.logLevel, file: config.logFile });
  const lock = acquireLock(config.lockFile);

  try {
    log.info(`${APP} ${VERSION} starting`);
    const daemon = await startDaemon(config, log);
    if (daemon.dashboard) log.info(`dashboard: ${daemon.dashboard.url}`);
    await daemon.done;
  } finally {
    lock.release();
    log.close();
  }
}

// Standalone dashboard: useful to inspect state while the harness is not
// running (or from another terminal). Settings saved here are picked up by the
// daemon on the next restart; a running daemon reloads a chat immediately.
async function dashboard() {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, file: config.logFile });
  const port = config.dashboardPort || 7345;
  const owner = await lockOwner(config.lockFile);
  // Standalone mode cannot reload the daemon's in-memory sessions, but it can
  // report whether one is alive and serve the same read/settings API.
  const control = {
    alive: () => Boolean(owner?.alive),
    isRunning: () => Boolean(owner?.alive),
    runnerCount: () => 0,
  };
  const server = await startDashboard({ config, log, control, port });
  if (!server) {
    console.error('dashboard disabled (set WABOX_PI_DASHBOARD_PORT or dashboardPort)');
    process.exitCode = 1;
    return;
  }
  console.log(`dashboard: ${server.url}`);
  if (owner?.alive) {
    console.log(`note: ${APP} is running (pid ${owner.pid}); changes apply to the next session.`);
  }
  const close = async () => {
    await server.close();
    log.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
  await new Promise(() => {});
}

export async function main(argv) {
  const [command = 'run', ...rest] = argv;

  switch (command) {
    case 'run':
    case 'start':
      return run({ dashboard: rest.includes('--dashboard') });
    case 'dashboard':
      return dashboard();
    case 'status':
      return status(rest.includes('--json'));
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    case 'help':
    case '--help':
    case '-h':
      return usage();
    default:
      if (command.startsWith('-')) return usage();
      console.error(`unknown command: ${command}`);
      usage();
      process.exitCode = 1;
  }
}

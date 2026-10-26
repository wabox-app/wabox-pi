// wabox-pi dashboard SPA. No build step, no framework: hash routing plus a
// handful of render functions that talk to the JSON API in src/dashboard.js.

const $ = (sel, root = document) => root.querySelector(sel);
const content = $('#content');
const convList = $('#convList');
const tabsEl = $('#tabs');

const state = {
  status: null,
  conversations: [],
  models: null,
  slug: null,
  tab: 'overview',
  logTimer: null,
  transcriptSession: null,
  file: null,
};

/* ---------- helpers ---------- */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pt-BR');
};

const fmtAgo = (value) => {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return '—';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const bytes = (n) => {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function fail(err) {
  toast(err.message ?? String(err), true);
  console.error(err);
}

function errorBox(message) {
  return message ? `<div class="error-box">${esc(message)}</div>` : '';
}

/* ---------- routing ---------- */

function parseHash() {
  const parts = (location.hash || '#/overview').replace(/^#\/?/, '').split('/');
  if (parts[0] === 'c' && parts[1]) {
    return { slug: decodeURIComponent(parts[1]), tab: parts[2] || 'overview' };
  }
  return { slug: null, tab: parts[0] || 'overview' };
}

function navigate(slug, tab = 'overview') {
  location.hash = slug ? `#/c/${encodeURIComponent(slug)}/${tab}` : `#/${tab}`;
}

window.addEventListener('hashchange', () => void render());

/* ---------- shell ---------- */

async function loadShell() {
  const [status, conversationData] = await Promise.all([api('/status'), api('/conversations')]);
  state.status = status;
  state.conversations = conversationData.conversations;
  renderStatus();
  renderConversations();
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  $('#version').textContent = `v${status.version ?? ''}`;
  const pill = $('#statusPill');
  pill.textContent = status.running ? `online · ${status.activeRunners} run` : 'offline';
  pill.className = `pill ${status.running ? 'ok' : 'bad'}`;
  $('#foot').innerHTML = `<span>${status.conversations} conversas</span><span>${status.tasks} jobs</span>`;
}

function renderConversations() {
  const query = $('#search').value.trim().toLowerCase();
  const items = state.conversations.filter((conv) => {
    const haystack = `${conv.identity?.pushName ?? ''} ${conv.identity?.from ?? ''} ${conv.slug}`.toLowerCase();
    return haystack.includes(query);
  });
  convList.innerHTML = items.length
    ? items
        .map(
          (conv) => `
      <div class="conv ${conv.slug === state.slug ? 'active' : ''}" data-slug="${esc(conv.slug)}">
        <span class="dot ${conv.running ? 'on' : ''}"></span>
        <div>
          <div class="name">${esc(conv.identity?.pushName || conv.identity?.from || conv.slug)}</div>
          <div class="sub">${esc(conv.identity?.number || conv.identity?.from || '')}</div>
        </div>
        <span class="when">${fmtAgo(conv.lastUsed)}</span>
      </div>`,
        )
        .join('')
    : `<div class="empty-state" style="padding:24px 8px">${query ? 'Nada encontrado.' : 'Nenhuma conversa ainda.'}</div>`;
}

convList.addEventListener('click', (event) => {
  const item = event.target.closest('.conv');
  if (item?.dataset.slug) navigate(item.dataset.slug, 'overview');
});

document.querySelectorAll('[data-nav]').forEach((button) => {
  button.addEventListener('click', () => navigate(null, button.dataset.nav));
});

$('#search').addEventListener('input', renderConversations);

/* ---------- render dispatcher ---------- */

async function render() {
  clearInterval(state.logTimer);
  state.logTimer = null;
  const route = parseHash();
  state.slug = route.slug;
  state.tab = route.tab;
  renderConversations();

  try {
    if (route.slug) {
      await renderConversation(route.slug, route.tab);
    } else if (route.tab === 'tasks') {
      await renderTasks();
    } else if (route.tab === 'logs') {
      await renderLogs();
    } else {
      await renderOverview();
    }
  } catch (err) {
    fail(err);
    content.innerHTML = errorBox(err.message);
  }
}

function setHeader(title, crumb = '') {
  $('#title').textContent = title;
  $('#crumb').innerHTML = crumb;
}

function setTabs(tabs, active, slug) {
  tabsEl.innerHTML = tabs
    .map(
      (tab) =>
        `<div class="tab ${tab.id === active ? 'active' : ''}" data-tab="${tab.id}">${esc(tab.label)}</div>`,
    )
    .join('');
  tabsEl.onclick = (event) => {
    const tab = event.target.closest('.tab');
    if (tab) navigate(slug, tab.dataset.tab);
  };
}

/* ---------- global views ---------- */

async function renderOverview() {
  setHeader('Visão geral');
  setTabs([], null, null);
  const status = state.status ?? (await api('/status'));
  state.status = status;
  const paths = status.paths;
  content.innerHTML = `
    <div class="grid">
      <div class="card">
        <h3>Estado</h3>
        <div class="big">${status.running ? 'online' : 'offline'}</div>
        <div class="row"><span class="k">runners ativos</span><span class="v">${status.activeRunners}</span></div>
        <div class="row"><span class="k">conversas</span><span class="v">${status.conversations}</span></div>
        <div class="row"><span class="k">jobs</span><span class="v">${status.tasks}</span></div>
      </div>
      <div class="card">
        <h3>Padrões</h3>
        <div class="row"><span class="k">autoReply</span><span class="v">${status.settings.autoReply}</span></div>
        <div class="row"><span class="k">batch</span><span class="v">${status.settings.batchWindowMs} ms</span></div>
        <div class="row"><span class="k">por participante</span><span class="v">${status.settings.groupPerParticipant}</span></div>
        <div class="row"><span class="k">tools</span><span class="v">${esc(status.settings.tools.join(', '))}</span></div>
      </div>
    </div>
    <div class="section">
      <h3>Pastas</h3>
      <div class="card">
        ${Object.entries(paths)
          .map(([key, value]) => `<div class="row"><span class="k">${esc(key)}</span><span class="v mono">${esc(value)}</span></div>`)
          .join('')}
      </div>
    </div>
    <div class="section">
      <h3>Conversas</h3>
      <div class="card">
        ${
          state.conversations.length
            ? state.conversations
                .map(
                  (conv) => `
          <div class="row">
            <span class="k"><a href="#/c/${encodeURIComponent(conv.slug)}/overview">${esc(conv.identity?.pushName || conv.slug)}</a></span>
            <span class="v">${conv.sessions} sessões · ${conv.processed} msgs · ${esc(conv.model ?? conv.modelProvider ?? 'modelo padrão')}</span>
          </div>`,
                )
                .join('')
            : '<div class="empty-state">Nenhuma conversa.</div>'
        }
      </div>
    </div>`;
}

async function renderTasks() {
  setHeader('Jobs agendados');
  setTabs([], null, null);
  const { tasks, error } = await api('/tasks');
  content.innerHTML = error ? errorBox(`tasks.json inválido: ${error}`) : '';
  content.innerHTML += tasks.length
    ? `<div class="card"><table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left;padding:6px 8px;color:var(--muted);font-size:11px;text-transform:uppercase">Nome</th>
          <th style="text-align:left;padding:6px 8px;color:var(--muted);font-size:11px;text-transform:uppercase">Cron</th>
          <th style="text-align:left;padding:6px 8px;color:var(--muted);font-size:11px;text-transform:uppercase">Alvo</th>
          <th style="text-align:left;padding:6px 8px;color:var(--muted);font-size:11px;text-transform:uppercase">Próxima</th>
          <th style="text-align:left;padding:6px 8px;color:var(--muted);font-size:11px;text-transform:uppercase">Fonte</th>
        </tr></thead><tbody>
        ${tasks
          .map(
            (task) => `<tr>
              <td style="padding:6px 8px">${esc(task.name)}${task.silent ? ' <span class="pill">silent</span>' : ''}</td>
              <td style="padding:6px 8px" class="mono">${esc(task.cron)}${task.timezone ? ` <span class="pill">${esc(task.timezone)}</span>` : ''}</td>
              <td style="padding:6px 8px" class="mono">${esc(task.slug || task.to || '—')}</td>
              <td style="padding:6px 8px">${task.error ? `<span class="pill bad">${esc(task.error)}</span>` : task.enabled ? fmtDate(task.next) : '<span class="pill">desativado</span>'}</td>
              <td style="padding:6px 8px">${esc(task.source)}</td>
            </tr>`,
          )
          .join('')}
      </tbody></table></div>`
    : '<div class="empty-state">Nenhum job agendado.</div>';
}

async function renderLogs() {
  setHeader('Logs');
  setTabs([], null, null);
  content.innerHTML = `<div class="card"><div class="actions" style="margin-bottom:10px">
      <button class="btn" id="refreshLog">Atualizar</button>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)">
        <input type="checkbox" id="autoLog" checked> auto
      </label>
    </div><div class="log-view" id="logView">…</div></div>`;

  const load = async () => {
    const { log } = await api('/log?lines=400');
    $('#logView').innerHTML = log
      ? log
          .split('\n')
          .map((line) => {
            const level = /\s(ERROR|WARN|DEBUG)\s/.exec(line)?.[1]?.toLowerCase();
            return `<div class="${level ?? ''}">${esc(line)}</div>`;
          })
          .join('')
      : '<div class="empty-state">Log vazio.</div>';
  };
  await load();
  $('#refreshLog').onclick = () => load().catch(fail);
  state.logTimer = setInterval(() => {
    if ($('#autoLog')?.checked) load().catch(() => {});
  }, 4000);
}

/* ---------- conversation ---------- */

const TABS = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'chat', label: 'Mensagens' },
  { id: 'session', label: 'Sessão' },
  { id: 'config', label: 'Configuração' },
  { id: 'vision', label: 'Visão' },
  { id: 'audio', label: 'Áudio' },
  { id: 'prompt', label: 'System prompt' },
  { id: 'workspace', label: 'Workspace' },
];

async function renderConversation(slug, tab) {
  const [conversation, settings] = await Promise.all([
    api(`/conversations/${encodeURIComponent(slug)}`),
    api(`/conversations/${encodeURIComponent(slug)}/settings`),
  ]);
  const name = conversation.identity?.pushName || conversation.identity?.from || slug;
  setHeader(name, `<span class="mono" style="color:var(--muted)">${esc(slug)}</span>`);
  setTabs(TABS, tab, slug);

  const renderers = {
    overview: renderConvOverview,
    chat: renderConvChat,
    session: renderConvSession,
    config: renderConvConfig,
    vision: renderConvVision,
    audio: renderConvAudio,
    prompt: renderConvPrompt,
    workspace: renderConvWorkspace,
  };
  await (renderers[tab] ?? renderConvOverview)(conversation, settings);
}

async function renderConvOverview(conv, settings) {
  const identity = conv.identity ?? {};
  const effective = settings.effective;
  const cards = [
    {
      title: 'Contato',
      body: `
        <div class="row"><span class="k">from</span><span class="v mono">${esc(identity.from ?? '—')}</span></div>
        <div class="row"><span class="k">número</span><span class="v">${esc(identity.number ?? '—')}</span></div>
        <div class="row"><span class="k">participante</span><span class="v mono">${esc(identity.participant ?? '—')}</span></div>
        <div class="row"><span class="k">atualizado</span><span class="v">${fmtDate(identity.updatedAt)}</span></div>`,
    },
    {
      title: 'Estado',
      body: `
        <div class="big">${conv.running ? 'ativa' : 'ociosa'}</div>
        <div class="row"><span class="k">sessões</span><span class="v">${conv.sessions.length}</span></div>
        <div class="row"><span class="k">mensagens</span><span class="v">${conv.processed}</span></div>
        <div class="row"><span class="k">arquivos</span><span class="v">${conv.files.length}</span></div>`,
    },
    {
      title: 'Modelo efetivo',
      body: `
        <div class="big" style="font-size:15px">${esc(effective.model ? `${effective.modelProvider ?? '?'}/${effective.model}` : 'padrão do pi')}</div>
        <div class="row"><span class="k">thinking</span><span class="v">${esc(effective.thinkingLevel ?? '—')}</span></div>
        <div class="row"><span class="k">autoReply</span><span class="v">${effective.autoReply !== false}</span></div>
        <div class="row"><span class="k">timeout</span><span class="v">${effective.turnTimeoutMs ?? '—'} ms</span></div>`,
    },
    {
      title: 'Visão (imagens recebidas)',
      body: visionCardBody(effective.vision, settings.instance.vision),
    },
    {
      title: 'Áudio (notas de voz)',
      body: audioCardBody(effective.transcription),
    },
  ];

  content.innerHTML = `
    <div class="grid">${cards.map((card) => `<div class="card"><h3>${card.title}</h3>${card.body}</div>`).join('')}</div>
    <div class="section">
      <h3>Workspace</h3>
      <div class="card"><code>${esc(conv.workspace)}</code></div>
    </div>
    <div class="section">
      <h3>Ações</h3>
      <div class="card">
        <div class="actions">
          <button class="btn" id="reloadConv">Recarregar sessão</button>
          <button class="btn danger" id="resetConv">Limpar contexto (/new)</button>
        </div>
        <div class="hint">Recarregar descarta a sessão em memória; a próxima mensagem reconstrói com a configuração atual. Limpar contexto apaga os arquivos .jsonl da conversa.</div>
      </div>
    </div>`;

  $('#reloadConv').onclick = async () => {
    try {
      const result = await api(`/conversations/${encodeURIComponent(conv.slug)}/reload`, {
        method: 'POST',
      });
      toast(result.reloaded ? 'Sessão recarregada.' : 'Daemon não está rodando; nada a recarregar.');
    } catch (err) {
      fail(err);
    }
  };
  $('#resetConv').onclick = async () => {
    if (!confirm('Apagar o contexto desta conversa? O workspace e a mídia ficam.')) return;
    try {
      const result = await api(`/conversations/${encodeURIComponent(conv.slug)}/reset`, { method: 'POST' });
      toast(`${result.removed} sessão(ões) removida(s).`);
    } catch (err) {
      fail(err);
    }
  };
}

async function renderConvChat(conv) {
  const { messages } = await api(`/conversations/${encodeURIComponent(conv.slug)}/messages?limit=200`);
  content.innerHTML = messages.length
    ? `<div class="actions" style="justify-content:flex-end;margin-bottom:10px">
        <span class="pill">${messages.length} mensagens processadas</span>
      </div>
      ${messages
        .map(
          (msg) => `
        <div class="chat-msg">
          <div class="meta">
            <span>${esc(msg.pushName || msg.number || msg.from || 'desconhecido')}</span>
            <span>${fmtDate(msg.timestamp)}</span>
          </div>
          <div class="text">${esc(msg.text) || '<span style="color:var(--muted)">(sem texto)</span>'}</div>
          ${msg.media ? `<div class="media">📎 ${esc(msg.media.type ?? 'arquivo')}${msg.media.mimetype ? ` · ${esc(msg.media.mimetype)}` : ''}</div>` : ''}
        </div>`,
        )
        .join('')}`
    : '<div class="empty-state">Nenhuma mensagem processada ainda.</div>';
}

function renderEvent(event, index) {
  if (event.type === 'user') {
    return `<div class="msg user">
      <div class="head"><span class="role">usuário</span><span>${fmtDate(event.timestamp)}</span></div>
      <div class="body">${esc(event.text) || '(vazio)'}</div>
    </div>`;
  }
  if (event.type === 'assistant') {
    const usage = event.usage
      ? `${event.usage.input ?? 0} in / ${event.usage.output ?? 0} out · $${(event.usage.cost?.total ?? 0).toFixed(4)}`
      : '';
    return `<div class="msg assistant">
      <div class="head">
        <span class="role">assistant</span>
        <span>${esc(event.model ?? '')}</span>
        <span>${event.durationMs ?? '—'} ms</span>
        <span>${esc(usage)}</span>
      </div>
      ${event.text ? `<div class="body">${esc(event.text)}</div>` : '<div class="body empty">(sem texto)</div>'}
      ${
        event.thinking
          ? `<details><summary>thinking</summary><pre>${esc(event.thinking)}</pre></details>`
          : ''
      }
      ${
        event.tools?.length
          ? event.tools
              .map(
                (tool) => `<details><summary>🔧 ${esc(tool.name)}</summary><pre>${esc(
                  JSON.stringify(tool.arguments, null, 2),
                )}</pre></details>`,
              )
              .join('')
          : ''
      }
      ${event.error ? `<div class="error">${esc(event.error)}</div>` : ''}
    </div>`;
  }
  if (event.type === 'tool') {
    return `<div class="msg tool">
      <div class="head"><span class="role">tool</span><span>${esc(event.name)}</span><span>${fmtDate(event.timestamp)}</span></div>
      <details><summary>resultado${event.isError ? ' (erro)' : ''}</summary><pre>${esc(event.text).slice(0, 8000)}</pre></details>
    </div>`;
  }
  if (event.type === 'system') {
    return `<div class="msg system">
      <div class="head"><span class="role">system prompt</span><span>${esc(event.text.length)} chars</span></div>
      <details><summary>ver prompt</summary><pre>${esc(event.text)}</pre></details>
    </div>`;
  }
  if (event.type === 'model') {
    return `<div class="msg system"><div class="head"><span class="role">modelo</span><span>${esc(event.provider)}/${esc(event.modelId)}</span></div></div>`;
  }
  if (event.type === 'thinkingLevel') {
    return `<div class="msg system"><div class="head"><span class="role">thinking</span><span>${esc(event.level)}</span></div></div>`;
  }
  if (event.type === 'contextEdit') {
    return `<div class="msg system"><div class="head"><span class="role">contexto</span><span>mensagem compactada/removida</span></div></div>`;
  }
  return '';
}

async function renderConvSession(conv) {
  if (!conv.sessions.length) {
    content.innerHTML = '<div class="empty-state">Nenhuma sessão salva. A próxima mensagem cria uma.</div>';
    return;
  }
  const selected = state.transcriptSession && conv.sessions.some((s) => s.name === state.transcriptSession)
    ? state.transcriptSession
    : conv.sessions[0].name;
  state.transcriptSession = selected;

  content.innerHTML = `
    <div class="actions" style="margin-bottom:14px">
      <select id="sessionSelect" style="max-width:520px">
        ${conv.sessions
          .map(
            (session) =>
              `<option value="${esc(session.name)}" ${session.name === selected ? 'selected' : ''}>${esc(session.name)} · ${bytes(session.size)}</option>`,
          )
          .join('')}
      </select>
    </div>
    <div id="transcript"><div class="empty-state">Carregando…</div></div>`;

  const load = async (name) => {
    state.transcriptSession = name;
    const data = await api(
      `/conversations/${encodeURIComponent(conv.slug)}/transcript?session=${encodeURIComponent(name)}`,
    );
    $('#transcript').innerHTML = `
      <div class="actions" style="margin-bottom:10px">
        <span class="pill">${data.events.length} eventos</span>
        ${data.meta ? `<span class="pill">${esc(data.meta.id)}</span>` : ''}
        ${data.model ? `<span class="pill">${esc(data.model.provider)}/${esc(data.model.modelId)}</span>` : ''}
        ${data.thinkingLevel ? `<span class="pill">thinking ${esc(data.thinkingLevel)}</span>` : ''}
      </div>
      ${data.events.map(renderEvent).join('') || '<div class="empty-state">Sessão vazia.</div>'}`;
  };
  $('#sessionSelect').onchange = (event) => load(event.target.value).catch(fail);
  await load(selected);
}

/* ---------- config form ---------- */

const FIELDS = [
  { key: 'modelProvider', label: 'Provider', type: 'provider' },
  { key: 'model', label: 'Modelo', type: 'model' },
  { key: 'thinkingLevel', label: 'Thinking level', type: 'thinking' },
  { key: 'systemPrompt', label: 'System prompt inline', type: 'hidden' },
  { key: 'autoReply', label: 'autoReply — enviar texto final se o agente não usar wabox_send', type: 'bool' },
  { key: 'errorReply', label: 'errorReply — avisar no chat quando um turno falhar', type: 'bool' },
  { key: 'ackReact', label: 'ackReact — emoji ao receber', type: 'text' },
  { key: 'batchWindowMs', label: 'batchWindowMs — agrupar rajada (ms)', type: 'int' },
  { key: 'turnTimeoutMs', label: 'turnTimeoutMs — abortar turno (ms, 0 = off)', type: 'int' },
  { key: 'turnFeedbackMs', label: 'turnFeedbackMs — reagir após (ms, 0 = off)', type: 'int' },
  { key: 'turnFeedbackReact', label: 'turnFeedbackReact — emoji "trabalhando"', type: 'text' },
  { key: 'contextCompactRatio', label: 'contextCompactRatio — compactar em (0–1)', type: 'number' },
  { key: 'contextCompactWarnTokens', label: 'contextCompactWarnTokens — avisar em tokens', type: 'int' },
  { key: 'ignoreEmojiOnly', label: 'ignoreEmojiOnly — ignorar mensagens só com emoji', type: 'bool' },
  { key: 'ignoreEmpty', label: 'ignoreEmpty — ignorar envelopes vazios', type: 'bool' },
  { key: 'logTokens', label: 'logTokens — registrar tokens por turno', type: 'bool' },
  { key: 'tools', label: 'tools — allowlist (separado por vírgula)', type: 'list' },
  { key: 'excludeTools', label: 'excludeTools — denylist', type: 'list' },
  { key: 'jail', label: 'jail — prender ferramentas de arquivo no workspace', type: 'bool' },
  { key: 'sandboxBash', label: 'sandboxBash', type: 'sandbox' },
  { key: 'sandboxNetwork', label: 'sandboxNetwork — rede no bash', type: 'bool' },
  { key: 'sandboxBashBin', label: 'sandboxBashBin', type: 'text' },
  { key: 'sandboxDenyRead', label: 'sandboxDenyRead — caminhos ocultos', type: 'list' },
  { key: 'sandboxAllowRead', label: 'sandboxAllowRead — reexpostos (ro)', type: 'list' },
  { key: 'workspace', label: 'workspace — diretório de trabalho', type: 'text' },
  { key: 'workspaceTemplate', label: 'workspaceTemplate — AGENTS.md inicial', type: 'text' },
];

function fieldControl(field, value, inherited) {
  const id = `f-${field.key}`;
  const placeholder = inherited === undefined || inherited === null || inherited === ''
    ? ''
    : ` placeholder="${esc(Array.isArray(inherited) ? inherited.join(', ') : String(inherited))}"`;

  if (field.type === 'bool') {
    return `<select id="${id}" data-key="${field.key}" data-type="bool">
      <option value="inherit" ${value === undefined ? 'selected' : ''}>(herdar: ${inherited === false ? 'não' : 'sim'})</option>
      <option value="true" ${value === true ? 'selected' : ''}>sim</option>
      <option value="false" ${value === false ? 'selected' : ''}>não</option>
    </select>`;
  }
  if (field.type === 'thinking') {
    const levels = ['', 'low', 'medium', 'high'];
    return `<select id="${id}" data-key="${field.key}" data-type="text">
      <option value="inherit">(herdar: ${esc(inherited ?? 'padrão')})</option>
      ${levels
        .filter(Boolean)
        .map((level) => `<option value="${level}" ${value === level ? 'selected' : ''}>${level}</option>`)
        .join('')}
      ${value && !levels.includes(value) ? `<option value="${esc(value)}" selected>${esc(value)}</option>` : ''}
    </select>`;
  }
  if (field.type === 'sandbox') {
    return `<select id="${id}" data-key="${field.key}" data-type="text">
      <option value="inherit">(herdar: ${esc(inherited ?? 'auto')})</option>
      ${['off', 'auto', 'bwrap']
        .map((mode) => `<option value="${mode}" ${value === mode ? 'selected' : ''}>${mode}</option>`)
        .join('')}
    </select>`;
  }
  if (field.type === 'provider' || field.type === 'model') {
    return `<input id="${id}" data-key="${field.key}" data-type="text" list="model-options"
      value="${esc(value ?? '')}"${placeholder} autocomplete="off">`;
  }
  if (field.type === 'list') {
    return `<input id="${id}" data-key="${field.key}" data-type="list"
      value="${esc(Array.isArray(value) ? value.join(', ') : value ?? '')}"${placeholder} autocomplete="off">`;
  }
  if (field.type === 'int' || field.type === 'number') {
    const type = field.type === 'int' ? 'number' : 'number';
    const step = field.type === 'number' ? ' step="0.05" min="0" max="1"' : ' step="1" min="0"';
    return `<input id="${id}" data-key="${field.key}" data-type="${field.type}" type="${type}"${step}
      value="${value === undefined ? '' : esc(value)}"${placeholder}>`;
  }
  return `<input id="${id}" data-key="${field.key}" data-type="text" value="${esc(value ?? '')}"${placeholder} autocomplete="off">`;
}

async function renderConvConfig(conv, settings) {
  const { models, providers } = await ensureModels();
  const overrides = settings.overrides;
  const effective = settings.effective;

  content.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3>Configuração da conversa</h3>
      <div class="hint" style="margin-bottom:10px">
        Campos vazios herdam a configuração da instância (mostrada como placeholder).
        Salvar reinicia a sessão em memória; o próximo turno usa os novos valores.
      </div>
      <datalist id="model-options">
        ${models.map((model) => `<option value="${esc(model.id)}">${esc(model.provider)} · ${esc(model.name)}</option>`).join('')}
      </datalist>
      <form id="configForm">
        ${FIELDS.filter((field) => field.type !== 'hidden')
          .map(
            (field) => `
          <div class="field">
            <label for="f-${field.key}">${esc(field.label)}</label>
            ${fieldControl(field, overrides[field.key], effective[field.key] ?? settings.instance[field.key])}
          </div>`,
          )
          .join('')}
        <div class="actions">
          <button class="btn primary" type="submit">Salvar</button>
          <button class="btn" type="button" id="clearOverrides">Limpar todos os overrides</button>
        </div>
      </form>
    </div>
    <div class="section">
      <h3>Padrões da instância (${esc(settings.instance.modelProvider ?? 'pi default')}/${esc(settings.instance.model ?? '—')})</h3>
      <div class="card"><div class="actions">
        ${providers.map((provider) => `<span class="pill">${esc(provider)}</span>`).join('')}
      </div></div>
    </div>`;

  // Remember the rendered values so submit can send only the diff.
  document.querySelectorAll('#configForm [data-key]').forEach((el) => {
    el.dataset.initial = el.value;
  });

  $('#configForm').onsubmit = async (event) => {
    event.preventDefault();
    const patch = {};
    for (const field of FIELDS) {
      const el = $(`#f-${field.key}`);
      if (!el) continue;
      // Only send what the operator actually changed: a field that was already
      // blank must not clear an existing override by accident.
      if (el.value === el.dataset.initial) continue;
      const raw = el.value;
      const type = el.dataset.type;
      if (type === 'bool') {
        if (raw === 'inherit') patch[field.key] = null;
        else patch[field.key] = raw === 'true';
      } else if (raw === '' || raw === 'inherit') {
        patch[field.key] = null;
      } else if (type === 'list') {
        patch[field.key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
      } else if (type === 'int') {
        patch[field.key] = Number.parseInt(raw, 10);
      } else if (type === 'number') {
        patch[field.key] = Number(raw);
      } else {
        patch[field.key] = raw;
      }
    }
    if (!Object.keys(patch).length) {
      toast('Nada mudou.');
      return;
    }
    try {
      await api(`/conversations/${encodeURIComponent(conv.slug)}/settings`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      toast('Configuração salva.');
      await render();
    } catch (err) {
      fail(err);
    }
  };

  $('#clearOverrides').onclick = async () => {
    if (!confirm('Remover todos os overrides desta conversa?')) return;
    const patch = Object.fromEntries(Object.keys(overrides).map((key) => [key, null]));
    try {
      await api(`/conversations/${encodeURIComponent(conv.slug)}/settings`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      toast('Overrides removidos.');
      await render();
    } catch (err) {
      fail(err);
    }
  };
}

async function ensureModels() {
  if (state.models) return state.models;
  try {
    state.models = await api('/models');
  } catch (err) {
    // A catalog failure must not block the rest of the settings form.
    console.warn('model catalog unavailable', err);
    state.models = { models: [], providers: [] };
  }
  return state.models;
}



/* ---------- audio ---------- */

function audioCardBody(t) {
  const v = t ?? {};
  const backends = [];
  if (v.command || v.provider || v.baseUrl) backends.push(v);
  backends.push(...(Array.isArray(v.fallback) ? v.fallback : []));
  const active = v.enabled !== false ? backends.filter((b) => b.command || b.provider || b.baseUrl) : [];
  if (!active.length) {
    return `<div class="big" style="font-size:15px">desativado</div>
      <div class="hint">Configure um backend de transcrição na aba Áudio (OpenRouter, endpoint OpenAI-compatível ou comando local).</div>`;
  }
  const first = active[0];
  const label = first.command
    ? 'command'
    : `${first.provider ?? (first.baseUrl ? 'openai' : '?')}/${first.model ?? '?'}`;
  return `
    <div class="big" style="font-size:15px">${esc(label)}</div>
    <div class="row"><span class="k">backends</span><span class="v">${active.length}${active.length > 1 ? ` (${active.length - 1} fallback)` : ''}</span></div>
    <div class="row"><span class="k">idioma</span><span class="v">${esc(v.language ?? 'auto')}</span></div>
    <div class="hint">Se o backend principal falhar (créditos, queda, chave), o próximo da lista é tentado.</div>`;
}

async function renderConvAudio(conv, settings) {
  const { providers } = await ensureModels();
  const instance = settings.instance.transcription ?? {};
  const override = settings.overrides.transcription ?? {};
  const effective = settings.effective.transcription ?? {};
  const opt = (value, label, current) =>
    `<option value="${esc(value)}" ${String(current) === String(value) ? 'selected' : ''}>${esc(label)}</option>`;

  const tri = (key, inherited) =>
    `<select data-tkey="${key}" data-ttype="bool">
      <option value="" ${override[key] === undefined ? 'selected' : ''}>(herdar: ${inherited === false ? 'não' : 'sim'})</option>
      ${opt('true', 'sim', override[key])}
      ${opt('false', 'não', override[key])}
    </select>`;

  const fallbackJson = JSON.stringify(Array.isArray(override.fallback) ? override.fallback : [], null, 2);

  content.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3>Transcrição de áudio</h3>
      <div class="hint" style="margin-bottom:12px">
        Notas de voz são transcritas antes do turno. O backend principal é tentado primeiro;
        cada entrada de <code>fallback</code> é tentada em ordem se ele falhar.
        Campos vazios herdam a instância (placeholder).
      </div>
      <form id="audioForm">
        <div class="field">
          <label>Ativado</label>
          ${tri('enabled', instance.enabled)}
        </div>
        <div class="field">
          <label>Backend principal (provider)</label>
          <input data-tkey="provider" data-ttype="text" list="audio-providers" value="${esc(override.provider ?? '')}"
            placeholder="${esc(instance.provider ?? (instance.command ? 'command' : instance.baseUrl ? 'openai' : 'openrouter | openai | command | id de provider do pi'))}"
            autocomplete="off">
          <datalist id="audio-providers">
            <option value="openrouter">openrouter (chat + input_audio)</option>
            <option value="openai">openai (endpoint /audio/transcriptions)</option>
            <option value="command">command (executável local)</option>
            ${providers.map((provider) => `<option value="${esc(provider)}">${esc(provider)} (modelo do pi)</option>`).join('')}
          </datalist>
          <div class="hint">
            Um id de provider do pi (ex.: <code>opencode-go</code>) usa a credencial do pi e o modelo
            informado, via Gemini (<code>inlineData</code>) ou chat com <code>input_audio</code>.
          </div>
          <datalist id="audio-model-options">
            ${models.map((model) => `<option value="${esc(model.id)}">${esc(model.provider)} · ${esc(model.name)}</option>`).join('')}
          </datalist>
        </div>
        <div class="two-col">
          <div class="field">
            <label>Modelo</label>
            <input data-tkey="model" data-ttype="text" list="audio-model-options" value="${esc(override.model ?? '')}"
              placeholder="${esc(instance.model ?? 'ex.: gemini-4-argon (pi) ou whisper-large-v3')}" autocomplete="off">
          </div>
          <div class="field">
            <label>Idioma (ISO, vazio = auto)</label>
            <input data-tkey="language" data-ttype="text" value="${esc(override.language ?? '')}"
              placeholder="${esc(instance.language ?? 'pt')}" autocomplete="off">
          </div>
        </div>
        <div class="field">
          <label>baseUrl (para provider openai)</label>
          <input data-tkey="baseUrl" data-ttype="text" value="${esc(override.baseUrl ?? '')}"
            placeholder="${esc(instance.baseUrl ?? 'ex.: https://api.groq.com/openai/v1/audio/transcriptions')}" autocomplete="off">
        </div>
        <div class="field">
          <label>Command local (recebe o áudio como argumento; stdout = transcrição)</label>
          <input data-tkey="command" data-ttype="text" value="${esc(override.command ?? '')}"
            placeholder="${esc(instance.command ?? '—')}" autocomplete="off">
        </div>
        <div class="field">
          <label>Prompt/instrução para o backend</label>
          <textarea data-tkey="prompt" data-ttype="text" placeholder="${esc(instance.prompt ?? 'padrão do backend')}">${esc(override.prompt ?? '')}</textarea>
        </div>
        <div class="field">
          <label>timeoutMs</label>
          <input type="number" min="1000" data-tkey="timeoutMs" data-ttype="int" value="${override.timeoutMs ?? ''}"
            placeholder="${esc(instance.timeoutMs ?? 120000)}">
        </div>
        <div class="field">
          <label>Fallback (JSON — lista de backends, tentados em ordem)</label>
          <textarea data-initial="${esc(fallbackJson)}" id="audioFallback" spellcheck="false"
            placeholder='[{"provider":"openai","baseUrl":"https://api.groq.com/openai/v1/audio/transcriptions","model":"whisper-large-v3","apiKeyFile":"stt-groq.key","language":"pt"}]'>${esc(fallbackJson)}</textarea>
          <div class="hint">
            Exemplo acima: OpenRouter como principal e Groq Whisper como reserva. Segredos aparecem
            como <code>[set]</code> e são preservados ao salvar; digite um valor novo para trocá-los.
          </div>
        </div>
        <div class="actions">
          <button class="btn primary" type="submit">Salvar áudio</button>
          <button class="btn danger" type="button" id="clearAudio">Remover override de áudio</button>
        </div>
        <div class="hint" style="margin-top:8px">
          Efetivo agora: ${esc(effective.command ? `command ${effective.command}` : effective.model ? `${effective.provider ?? (effective.baseUrl ? 'openai' : '?')}/${effective.model}` : 'não configurado')}
          · ${Array.isArray(effective.fallback) ? effective.fallback.length : 0} fallback(s)
          · idioma ${esc(effective.language ?? 'auto')}
        </div>
      </form>
    </div>`;

  $('#audioForm').onsubmit = async (event) => {
    event.preventDefault();
    const transcription = {};
    for (const el of document.querySelectorAll('#audioForm [data-tkey]')) {
      const key = el.dataset.tkey;
      const type = el.dataset.ttype;
      const raw = el.value;
      if (raw === '') continue;
      if (type === 'bool') transcription[key] = raw === 'true';
      else if (type === 'int') transcription[key] = Number.parseInt(raw, 10);
      else transcription[key] = raw;
    }

    const fallbackEl = $('#audioFallback');
    if (fallbackEl.value !== fallbackEl.dataset.initial) {
      const text = fallbackEl.value.trim();
      if (!text) {
        transcription.fallback = [];
      } else {
        let entries;
        try {
          entries = JSON.parse(text);
        } catch (err) {
          toast(`Fallback JSON inválido: ${err.message}`, true);
          return;
        }
        if (!Array.isArray(entries)) {
          toast('Fallback precisa ser uma lista JSON.', true);
          return;
        }
        transcription.fallback = entries;
      }
    }

    try {
      await api(`/conversations/${encodeURIComponent(conv.slug)}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ transcription: Object.keys(transcription).length ? transcription : null }),
      });
      toast('Configuração de áudio salva.');
      await render();
    } catch (err) {
      fail(err);
    }
  };

  $('#clearAudio').onclick = async () => {
    if (!confirm('Remover o override de áudio desta conversa? Volta a herdar a instância.')) return;
    try {
      await api(`/conversations/${encodeURIComponent(conv.slug)}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ transcription: null }),
      });
      toast('Override removido.');
      await render();
    } catch (err) {
      fail(err);
    }
  };
}

/* ---------- vision ---------- */

function visionCardBody(vision, instanceVision) {
  const v = vision ?? {};
  const configured = v.mode !== 'off' && v.enabled !== false && (v.command || v.model || v.modelProvider);
  if (!configured) {
    return `<div class="big" style="font-size:15px">desativado</div>
      <div class="hint">Configure um modelo na aba Visão para descrever imagens quando o modelo do chat não aceita imagem.</div>`;
  }
  return `
    <div class="big" style="font-size:15px">${esc(v.command ? 'command' : `${v.modelProvider ?? '?'}/${v.model ?? '?'}`)}</div>
    <div class="row"><span class="k">modo</span><span class="v">${esc(v.mode ?? 'auto')}</span></div>
    <div class="row"><span class="k">origem</span><span class="v">${instanceVision && (instanceVision.model || instanceVision.command) ? 'instância' : 'conversa'}</span></div>
    <div class="hint">No modo auto a imagem só é descrita quando o modelo ativo não aceita imagem.</div>`;
}

async function renderConvVision(conv, settings) {
  const { models } = await ensureModels();
  const instance = settings.instance.vision ?? {};
  const override = settings.overrides.vision ?? {};
  const effective = settings.effective.vision ?? {};
  const opt = (value, label, current) =>
    `<option value="${esc(value)}" ${String(current) === String(value) ? 'selected' : ''}>${esc(label)}</option>`;

  const tri = (key, label, inherited) =>
    `<select data-vkey="${key}" data-vtype="bool">
      <option value="" ${override[key] === undefined ? 'selected' : ''}>(herdar: ${inherited === false ? 'não' : 'sim'})</option>
      ${opt('true', 'sim', override[key])}
      ${opt('false', 'não', override[key])}
    </select>`;

  content.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3>Fallback de imagens</h3>
      <div class="hint" style="margin-bottom:12px">
        O modelo do chat pode ser só texto. Quando uma imagem chega, o wabox-pi a descreve
        com o modelo abaixo e coloca a descrição no prompt do turno. Campos vazios herdam a
        configuração da instância (mostrada como placeholder).
      </div>
      <datalist id="vision-model-options">
        ${models.map((model) => `<option value="${esc(model.id)}">${esc(model.provider)} · ${esc(model.name)}</option>`).join('')}
      </datalist>
      <form id="visionForm">
        <div class="field">
          <label>Ativado</label>
          ${tri('enabled', 'Ativado', instance.enabled)}
        </div>
        <div class="field">
          <label>Modo</label>
          <select data-vkey="mode" data-vtype="text">
            <option value="" ${override.mode === undefined ? 'selected' : ''}>(herdar: ${esc(instance.mode ?? 'auto')})</option>
            ${opt('auto', 'auto — só quando o modelo não vê imagens', override.mode)}
            ${opt('always', 'always — sempre descrever', override.mode)}
            ${opt('off', 'off — nunca descrever', override.mode)}
          </select>
        </div>
        <div class="two-col">
          <div class="field">
            <label>Provider do modelo de visão</label>
            <input data-vkey="modelProvider" data-vtype="text" value="${esc(override.modelProvider ?? '')}"
              placeholder="${esc(instance.modelProvider ?? 'ex.: openrouter')}" autocomplete="off">
          </div>
          <div class="field">
            <label>Modelo de visão</label>
            <input data-vkey="model" data-vtype="text" list="vision-model-options" value="${esc(override.model ?? '')}"
              placeholder="${esc(instance.model ?? 'ex.: google/gemini-2.5-flash')}" autocomplete="off">
          </div>
        </div>
        <div class="field">
          <label>Instrução para o modelo de visão</label>
          <textarea data-vkey="prompt" data-vtype="text" placeholder="${esc(instance.prompt ?? 'padrão: descrever texto, layout, objetos, números e erros')}">${esc(override.prompt ?? '')}</textarea>
        </div>
        <div class="two-col">
          <div class="field">
            <label>maxTokens</label>
            <input type="number" min="1" data-vkey="maxTokens" data-vtype="int" value="${override.maxTokens ?? ''}"
              placeholder="${esc(instance.maxTokens ?? 1024)}">
          </div>
          <div class="field">
            <label>timeoutMs</label>
            <input type="number" min="1000" data-vkey="timeoutMs" data-vtype="int" value="${override.timeoutMs ?? ''}"
              placeholder="${esc(instance.timeoutMs ?? 120000)}">
          </div>
        </div>
        <div class="field">
          <label>maxBytes da imagem</label>
          <input type="number" min="1000" data-vkey="maxBytes" data-vtype="int" value="${override.maxBytes ?? ''}"
            placeholder="${esc(instance.maxBytes ?? 8000000)}">
        </div>
        <div class="field">
          <label>Command local (opcional — recebe o caminho da imagem, stdout é a descrição)</label>
          <input data-vkey="command" data-vtype="text" value="${esc(override.command ?? '')}"
            placeholder="${esc(instance.command ?? '')}" autocomplete="off">
        </div>
        <div class="field">
          <label>Salvar sidecar .description.txt ao lado da mídia</label>
          ${tri('writeSidecar', 'sidecar', instance.writeSidecar)}
        </div>
        <div class="actions">
          <button class="btn primary" type="submit">Salvar visão</button>
          <button class="btn danger" type="button" id="clearVision">Remover override de visão</button>
        </div>
        <div class="hint" style="margin-top:8px">
          Efetivo agora: ${esc(effective.command ? `command ${effective.command}` : effective.model ? `${effective.modelProvider ?? '?'}/${effective.model}` : 'não configurado')}
          · modo ${esc(effective.mode ?? 'auto')}
          · modelProvider/model pode ficar vazio quando há um command.
        </div>
      </form>
    </div>`;

  $('#visionForm').onsubmit = async (event) => {
    event.preventDefault();
    const vision = {};
    for (const el of document.querySelectorAll('#visionForm [data-vkey]')) {
      const key = el.dataset.vkey;
      const type = el.dataset.vtype;
      const raw = el.value;
      if (raw === '') continue;
      if (type === 'bool') vision[key] = raw === 'true';
      else if (type === 'int') vision[key] = Number.parseInt(raw, 10);
      else vision[key] = raw;
    }
    try {
      await api(`/conversations/${encodeURIComponent(conv.slug)}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ vision: Object.keys(vision).length ? vision : null }),
      });
      toast('Configuração de visão salva.');
      await render();
    } catch (err) {
      fail(err);
    }
  };

  $('#clearVision').onclick = async () => {
    if (!confirm('Remover o override de visão desta conversa? Volta a herdar a instância.')) return;
    try {
      await api(`/conversations/${encodeURIComponent(conv.slug)}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ vision: null }),
      });
      toast('Override removido.');
      await render();
    } catch (err) {
      fail(err);
    }
  };
}

/* ---------- system prompt ---------- */

async function renderConvPrompt(conv) {
  const prompt = await api(`/conversations/${encodeURIComponent(conv.slug)}/system-prompt`);
  content.innerHTML = `
    <div class="two-col">
      <div class="card">
        <h3>SYSTEM.md (workspace)</h3>
        <div class="hint" style="margin-bottom:8px">
          Anexado ao system prompt desta conversa, depois das regras do harness.
          Fica em <code>${esc(conv.workspace)}/SYSTEM.md</code>.
        </div>
        <textarea id="promptFile" class="tall" spellcheck="false">${esc(prompt.file)}</textarea>
      </div>
      <div class="card">
        <h3>Override inline (config.json)</h3>
        <div class="hint" style="margin-bottom:8px">
          Vem de <code>conversations.${esc(conv.slug)}.systemPrompt</code>. É anexado
          antes do SYSTEM.md e sobrevive a mudanças de workspace.
        </div>
        <textarea id="promptInline" class="tall" spellcheck="false">${esc(prompt.inline)}</textarea>
      </div>
    </div>
    <div class="actions" style="margin-top:14px">
      <button class="btn primary" id="savePrompt">Salvar system prompt</button>
      <span class="hint">A sessão em memória é reiniciada; o próximo turno já usa o prompt novo.</span>
    </div>`;

  $('#savePrompt').onclick = async () => {
    try {
      await api(`/conversations/${encodeURIComponent(conv.slug)}/system-prompt`, {
        method: 'PUT',
        body: JSON.stringify({
          file: $('#promptFile').value,
          inline: $('#promptInline').value,
        }),
      });
      toast('System prompt salvo.');
      await render();
    } catch (err) {
      fail(err);
    }
  };
}

/* ---------- workspace ---------- */

async function renderConvWorkspace(conv) {
  const files = conv.files.filter((entry) => entry.type === 'file');
  const preferred = ['SYSTEM.md', 'AGENTS.md', 'MEMORY.md'];
  const target =
    state.file && files.some((f) => f.path === state.file)
      ? state.file
      : preferred.find((name) => files.some((f) => f.path === name)) ?? files[0]?.path ?? null;
  state.file = target;

  content.innerHTML = `
    <div class="two-col">
      <div class="card">
        <h3>Arquivos (${files.length})</h3>
        <div class="file-list" id="fileList">
          ${
            files.length
              ? files
                  .map(
                    (file) => `<div class="file-item ${file.path === target ? 'active' : ''}" data-path="${esc(file.path)}">
                      <span>${esc(file.path)}</span><span class="size">${bytes(file.size)}</span>
                    </div>`,
                  )
                  .join('')
              : '<div class="empty-state">Workspace vazio.</div>'
          }
        </div>
        <div class="actions" style="margin-top:12px">
          <input id="newFile" placeholder="novo-arquivo.md" style="max-width:220px">
          <button class="btn" id="createFile">Criar</button>
        </div>
      </div>
      <div class="card">
        <h3>${target ? esc(target) : 'Editor'}</h3>
        <textarea id="fileContent" class="tall" spellcheck="false" ${target ? '' : 'disabled'}>Carregando…</textarea>
        <div class="actions" style="margin-top:10px">
          <button class="btn primary" id="saveFile" ${target ? '' : 'disabled'}>Salvar</button>
        </div>
      </div>
    </div>`;

  const loadFile = async (path) => {
    if (!path) return;
    state.file = path;
    document.querySelectorAll('.file-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.path === path);
    });
    const data = await api(
      `/conversations/${encodeURIComponent(conv.slug)}/file?path=${encodeURIComponent(path)}`,
    );
    $('#fileContent').value = data.content;
    $('#fileContent').disabled = false;
    $('#saveFile').disabled = false;
    $('#fileContent').closest('.card').querySelector('h3').textContent = path;
  };

  $('#fileList').onclick = (event) => {
    const item = event.target.closest('.file-item');
    if (item) loadFile(item.dataset.path).catch(fail);
  };
  $('#saveFile').onclick = async () => {
    try {
      await api(
        `/conversations/${encodeURIComponent(conv.slug)}/file?path=${encodeURIComponent(state.file)}`,
        { method: 'PUT', body: JSON.stringify({ content: $('#fileContent').value }) },
      );
      toast('Arquivo salvo.');
    } catch (err) {
      fail(err);
    }
  };
  $('#createFile').onclick = async () => {
    const name = $('#newFile').value.trim();
    if (!name) return;
    try {
      await api(
        `/conversations/${encodeURIComponent(conv.slug)}/file?path=${encodeURIComponent(name)}`,
        { method: 'PUT', body: JSON.stringify({ content: '' }) },
      );
      state.file = name;
      await render();
    } catch (err) {
      fail(err);
    }
  };

  if (target) await loadFile(target).catch(fail);
}

/* ---------- boot ---------- */

async function boot() {
  try {
    await loadShell();
    await render();
  } catch (err) {
    fail(err);
    content.innerHTML = errorBox(`Não foi possível falar com o daemon: ${err.message}`);
  }
  setInterval(() => {
    loadShell().catch(() => {});
  }, 10_000);
}

boot();

// Appended to pi's normal system prompt (so project discovery and pi's own
// instructions still apply). Kept short: the per-turn prompt carries the
// message; this carries the WhatsApp conventions.

export function systemPromptAppend({ workspace, jailed = false, sandboxedBash = false, web = {}, imageGen = false, memory = null, imagesDescribed = false }) {
  let confinement;
  if (jailed && sandboxedBash) {
    confinement = `Stay inside that directory: it is the only place you can write. The file
tools reject any path outside it, and shell commands run in a sandbox where the
rest of the machine is read-only.`;
  } else if (jailed) {
    confinement = `Stay inside that directory. The file tools reject any path outside it, so
write anything you need there and pass those paths to \`wabox_send\`.`;
  } else {
    confinement = `Treat it as your project root and do not touch anything outside it.`;
  }
  return `
## WhatsApp reply channel (wabox)

You are talking to a person over WhatsApp, not to a terminal user.

- Use the \`wabox_send\` tool for everything you want delivered. It targets the
  current chat and quotes the message you are answering. It can send text,
  attach files from your workspace, and add or remove an emoji reaction.
- If you do not call \`wabox_send\` with text or files, your final assistant text
  is sent as the reply automatically. Never repeat in your final text what you
  already sent with the tool.
- Write like a chat message, not a report. Short paragraphs, one concern per
  message. Split a long answer across several \`wabox_send\` calls, or attach a
  document, rather than sending a wall of text.
- Match the sender's language.
- WhatsApp markup, not Markdown: *bold*, _italic_, ~strikethrough~, and
  \`\`\`monospace\`\`\`. No headings, no [links](url) — paste raw URLs.
- Acknowledge with a reaction (👀 "working on it", 👍 "got it") instead of
  spending a message on it.
- Incoming attachments are saved under the conversation's media folder and the
  prompt gives you their absolute paths. Use the read tool for images and
  documents. Voice notes are transcribed into the prompt when transcription is
  configured; if a transcript is missing or failed, say so briefly instead of
  pretending you heard it.${
  imagesDescribed
    ? `\n- When this model cannot see images, inbound images are described by a vision\n  model and the description is in the prompt. Rely on it, and say so if the\n  description failed instead of guessing what the picture shows.`
    : ''
}- The shell has **no network access**. For the web use ${
    [web.fetch ? '`wabox_fetch` to read a URL' : null, web.search ? '`wabox_search` to find pages' : null]
      .filter(Boolean)
      .join(' and ') || 'the web tools when available'
  } instead of curl or wget.${imageGen ? `
- Generate images with \`wabox_generate_image\` when asked. The saved file can
  then be attached with \`wabox_send\`.` : ''}
- Files you attach must be readable paths. Write generated files into your
  workspace first, then pass their paths to \`wabox_send\`.
- Do not mention internal ids, JIDs, session ids, or tool names to the user.

Your workspace for this conversation is:
${workspace}

${confinement}

You may keep durable notes in AGENTS.md in that workspace.
${memory ? `
## Memory

The following facts about this conversation have been recorded:

${memory}
` : `
## Memory

You may keep durable personal notes in MEMORY.md in that workspace (use the
read/write tools). Facts recorded there survive across sessions and are shown
to you at the start of each new session. Record things the user explicitly
asks you to remember (preferences, names, projects, constraints, etc.).
`}`.trim();
}

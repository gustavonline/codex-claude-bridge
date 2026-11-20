import { forkSession, getSessionMessages, importSessionToStore } from '@anthropic-ai/claude-agent-sdk';
import { isDeepStrictEqual } from 'node:util';
import { inputContent } from './claude.mjs';

// Read the selected session through the SDK, including chain entries such as
// tool results and structured-output attachments omitted by getSessionMessages.
// This stays in the backend; no transcript is added to the model's prompt.
async function entries(sessionId, cwd) {
  const rows = [];
  await importSessionToStore(sessionId, {
    append: async (_key, batch) => { rows.push(...batch); }, load: async () => null,
  }, { dir: cwd, includeSubagents: false });
  return rows.filter(e => e.uuid && !e.isSidechain && Object.hasOwn(e, 'parentUuid'));
}

// The PUBLIC, normalised conversation of one session (getSessionMessages: user / assistant messages in chronological order along the conversation chain; SessionMessage carries type, uuid,
// session_id, an opaque `message`, parent_tool_use_id and parent_agent_id). It is NOT the CLI-internal entry shape the undo / checkpoint code above reads (that shape is opaque by contract and
// is deliberately not used as receipt evidence). Nothing of it is returned to a model; only a verdict.
async function messages(sessionId, cwd) { return getSessionMessages(sessionId, { dir: cwd }); }

// A POSITIVE receipt that the model answered ONE prompt, from that public conversation: the message with the exact prompt uuid is a MAIN-agent user message of the exact session (parent_tool_use_id
// and parent_agent_id null), and a MAIN-agent assistant message of the same session follows it - before any later genuine user prompt - whose opaque payload validates at runtime as a real model
// answer (role assistant, content blocks, a named non-synthetic model, no error or API-error marker). A user message is skipped only if it is safely typed as a tool-result carrier (every content
// block a tool_result); any other user message, or one that does not validate, ends the walk. A malformed or unknown payload is never proof. Absence is NOT proof of anything: it is "no receipt".
export function noticeReceipt(messageList, promptId, sessionId) {
  const main = m => m !== null && typeof m === 'object' && m.session_id === sessionId && m.parent_tool_use_id === null && m.parent_agent_id === null;
  if (!Array.isArray(messageList) || typeof promptId !== 'string' || promptId === '' || typeof sessionId !== 'string' || sessionId === '') return { accepted: false, reason: 'unscoped' };
  const at = messageList.findIndex(m => main(m) && m.type === 'user' && m.uuid === promptId);
  if (at < 0) return { accepted: false, reason: 'prompt_not_recorded' };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const toolResult = m => object(m.message) && Array.isArray(m.message.content) && m.message.content.length > 0 && m.message.content.every(block => object(block) && block.type === 'tool_result');
  for (const m of messageList.slice(at + 1)) {
    if (!object(m)) break;
    if (m.type === 'system') continue;
    if (!main(m)) continue; // a subagent's messages are neither the main answer nor a new prompt
    if (m.type === 'user') { if (toolResult(m)) continue; break; }
    if (m.type !== 'assistant') break;
    const body = m.message;
    if (object(body) && body.role === 'assistant' && Array.isArray(body.content) && typeof body.model === 'string' && body.model !== '' && body.model !== '<synthetic>' && !body.error && !body.isApiErrorMessage && typeof m.uuid === 'string')
      return { accepted: true, assistantUuid: m.uuid };
  }
  return { accepted: false, reason: 'no_model_answer_recorded' };
}

export function sessionHistory({ read = entries, fork = forkSession, readMessages = messages } = {}) {
  return {
    // The public receipt of one recorded attempt, scoped to the exact chat, session, project directory and prompt uuid it was made under (anything else is "no receipt").
    async receipt(record, attempt) {
      if (!attempt || record.thread.ephemeral || attempt.threadId !== record.thread.id || typeof attempt.sessionId !== 'string' || !attempt.sessionId
        || typeof attempt.promptId !== 'string' || !attempt.promptId || typeof attempt.cwd !== 'string' || attempt.cwd !== record.thread.cwd) return { accepted: false, reason: 'unscoped' };
      return noticeReceipt(await readMessages(attempt.sessionId, attempt.cwd), attempt.promptId, attempt.sessionId);
    },
    async checkpoint(record) {
      if (!record.claudeSessionId || record.thread.ephemeral) return null;
      const rows = await read(record.claudeSessionId, record.thread.cwd);
      const tail = rows.at(-1);
      if (!tail) throw new Error('Claude session has no persisted history checkpoint');
      return { sessionId: record.claudeSessionId, messageId: tail.uuid };
    },
    async before(record, index) {
      if (index === 0) return undefined;
      const kept = record.turns[index - 1];
      let point = kept.claudeCheckpoint;
      if (point === null) return undefined; // No Claude history existed at this boundary.
      if (!point && index === record.turns.length && record.claudeSessionId) {
        const rows = await read(record.claudeSessionId, record.thread.cwd);
        if (!rows.length) throw new Error('Claude history is unavailable for this fork');
        point = { sessionId: record.claudeSessionId, messageId: rows.at(-1).uuid };
      }
      if (!point) {
        // Compatibility for chats created before checkpoints were recorded.
        // Only use a uniquely identifiable user prompt; never guess a boundary.
        const target = record.turns[index];
        const sessionId = target.claudeSessionId ?? record.claudeSessionId;
        if (!sessionId) throw new Error('No Claude checkpoint is available before this turn');
        const rows = await read(sessionId, record.thread.cwd);
        const content = await inputContent(target.items.find(i => i.type === 'userMessage')?.content ?? []);
        const candidates = rows.filter(e => e.type === 'user' && (target.claudePromptId
          ? e.uuid === target.claudePromptId
          : isDeepStrictEqual(typeof e.message?.content === 'string'
            ? [{ type: 'text', text: e.message.content }] : e.message?.content, content)));
        if (candidates.length !== 1 || !candidates[0].parentUuid)
          throw new Error('Cannot identify the retained Claude history safely; this chat was not changed');
        point = { sessionId, messageId: candidates[0].parentUuid };
      }
      // The official SDK creates an independent prefix and keeps the original
      // session intact. Checkpoints on older turns still refer to that original.
      const result = await fork(point.sessionId, { dir: record.thread.cwd, upToMessageId: point.messageId });
      if (!result?.sessionId || result.sessionId === point.sessionId) throw new Error('Claude did not create an independent history branch');
      return result.sessionId;
    },
  };
}

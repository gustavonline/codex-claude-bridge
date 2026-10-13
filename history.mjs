import { forkSession, importSessionToStore } from '@anthropic-ai/claude-agent-sdk';
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

export function sessionHistory({ read = entries, fork = forkSession } = {}) {
  return {
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

# Antigravity qualification (20 November)

**Result: not qualified, so Model Bridge does not run it.** An MCP-only Antigravity session is possible natively. But the repository's own Antigravity hooks run commands outside the Codex sandbox, so no Codex permission boundary holds.

## Setup

- **Runtime:** Google's Antigravity CLI 1.5.13, installed and SHA-512 verified by the coordinator.
- **Sign-in:** the owner's Google sign-in was completed by the coordinator. The probes reused it and never signed in again.
- **Environment:** auto-update off, file credential storage forced, and Google, Gemini, ADC and other provider variables removed.
- **Probes:** one ACP session each, `--process-per-session --disable-telemetry --include-default-customizations=false`.
- **Workspace:** a throwaway directory.
- **Model:** Gemini 3.8 Flash at thinking level low, used for a few short synthetic turns.
- **Tools offered:** Bridge-hosted HTTP MCP tools only.
- **Permission policy:** Bridge allowed its own MCP tool and denied every native request.

This is Linux protocol evidence. It is not macOS desktop evidence. Reproduce with `scripts/qualify-antigravity.mjs --run` (explicit opt-in; it reuses an existing login and writes only to the scratch directory given).

## Observed

| Question | Observed |
| --- | --- |
| Sign-in and billing route | `authenticate` with `oauth-personal` used the cached login. All model traffic went to the Code Assist subscription endpoint: `loadCodeAssist`, `fetchAvailableModels`, `streamGenerateContent`. Nothing went to the Gemini API-key or Vertex endpoints. |
| Models | Both `session/new` and `agy models` return what the server's `fetchAvailableModels` reports for this account: Gemini 3.8 Flash at low, medium and high, Claude Sonnet 4.6, Claude Opus 4.6 (Thinking) and GPT-OSS 120B. **Gemini Neon is not offered to this account.** The logs show no tier, so the cause (plan or rollout) is not established. Bridge does not invent it. |
| Default agent: MCP tool | Asks permission. When Bridge allows it, the call reaches Bridge's MCP handler. |
| Default agent: native edit and shell | Both ask permission. When denied, nothing was written or run, inside or outside the workspace. |
| Default agent: read and web search | Neither asks. A workspace file was read, and Google ran the search on its side. |
| Custom main agent with `tools: []` (from `.agents/agents/`) | Only MCP tools plus `manage_task`, `list_resources` and `read_resource` remain. Read, web search and shell are refused by the agent itself. |
| Custom agent naming an MCP tool in `tools` | Fails cleanly at every prompt ("tool not found in registry"); it does not hang. |
| **Workspace `.agents/hooks.json`** | **Its `SessionStart` and `PreInvocation` commands ran, with no permission request.** This held with default customizations off and with the MCP-only agent. |
| Teardown | Closing stdin ended all three processes within about 50–110 ms, with none left. |
| Codex's own sandbox (`codex sandbox -P :read-only` / `:workspace`) | Enforces writes as Codex does, but both profiles also block network. agy's process needs network and writes its state under `~/.gemini`. |
| Profile location | The cached login, conversations and config live under `$HOME/.gemini/` (`antigravity-cli/`, `config/`). `GEMINI_HOME` did not move them; only logs followed `--log-file`. |

## Why this is a refusal

Codex workspaces are routinely written by the model through Codex's own shell. A hooks file in any `.agents` directory between the workspace and the repository root runs on the next session start, or before the next model call, outside Codex's sandbox. Checking for such files beforehand is racy and incomplete.

The minimum boundary is therefore OS containment of agy's whole process tree. It must match the thread's file permissions, keep agy's state directory writable, and allow network only for Google's endpoints. Codex's built-in profiles block all network, and a profile that allows agy's network would also give its hooks network. That boundary has not been built or proven, so Model Bridge keeps Antigravity off and says why in Home.

## What would change this

- An official agy option that disables workspace hooks and other executable customizations for a session, verified natively.
- Or a proven OS boundary around the agy process tree with the properties above, plus an approval mapping test against Codex for each sandbox and approval combination.
- A Bridge-owned Antigravity profile (`--gemini-dir`) with its own sign-in, so the agent definition and config never live in a user workspace or in the person's own `~/.gemini`. This needs a fresh owner sign-in through the proper flow.

# Antigravity qualification (20 November)

**Result: not qualified, so Model Bridge does not run it.** An MCP-only Antigravity session is possible natively. But a workspace's own Antigravity hooks run commands outside the Codex sandbox, so no Codex permission boundary holds.

## Setup

- **Runtime:** Google's Antigravity CLI 1.5.13, installed and SHA-512 verified by the coordinator.
- **Sign-in:** the owner's Google sign-in was completed by the coordinator. The probes reused it and never signed in again.
- **Environment:** auto-update off, file credential storage forced, and Google, Gemini, ADC and other provider variables removed.
- **Probes:** one ACP session each, `--process-per-session --disable-telemetry --include-default-customizations=false`.
- **Workspace:** a throwaway directory.
- **Model:** Gemini 3.8 Flash at thinking level low, used for a few short synthetic turns.
- **Tools offered:** Bridge-hosted HTTP MCP tools only.
- **Permission policy:** Bridge allowed its own MCP tool and denied every native request.

This is Linux protocol evidence. It is not macOS desktop evidence. Reproduce the ACP rows with `scripts/qualify-antigravity.mjs --run`. It is an explicit opt-in that reuses an existing login, creates a fresh run directory inside the parent it is given, and never deletes anything. agy itself still records each probe session in the signed-in profile. One synthetic session per probe run remains in this VM's Antigravity profile (`$HOME/.gemini/antigravity-cli/conversations`). They are not removed here, because that profile belongs to the coordinator's login.

The script does not cover two rows: `agy models` and the Codex sandbox row were run by hand with the commands named there. The endpoint facts come from agy's own server log, not from captured traffic.

## Observed

| Question | Observed |
| --- | --- |
| Sign-in and billing route | `authenticate` with `oauth-personal` used the cached login. agy's own server log lists only Code Assist subscription endpoints: `loadCodeAssist`, `fetchAvailableModels`, `generateContent`, `streamGenerateContent`. It lists no Gemini API-key or Vertex endpoint. Traffic was not captured independently. |
| Models | Both `session/new` and `agy models` (run by hand) return what the server's `fetchAvailableModels` reports for this account: Gemini 3.8 Flash at low, medium and high, Claude Sonnet 4.6, Claude Opus 4.6 (Thinking) and GPT-OSS 120B. **Gemini Neon is not offered to this account.** The logs show no tier, so the cause (plan or rollout) is not established. Bridge does not invent it. |
| Default agent: MCP tool | Asks permission. When Bridge allows it, the call reaches Bridge's MCP handler. |
| Default agent: native edit and shell | Both ask permission. When denied, nothing was written or run, inside or outside the workspace. |
| Default agent: read and web search | Neither asks. A workspace file was read, and Google ran the search on its side. |
| Custom main agent with `tools: []` (from `.agents/agents/`) | Only MCP tools plus `manage_task`, `list_resources` and `read_resource` remain. Read, web search and shell are refused by the agent itself. |
| Custom agent naming an MCP tool in `tools` | Fails cleanly at every prompt ("tool not found in registry"); it does not hang. |
| **Workspace `.agents/hooks.json`** (tested at the workspace root, outside any repository) | **Its `SessionStart` and `PreInvocation` commands ran, with no permission request.** This held with default customizations off and with the MCP-only agent. Ancestor `.agents` directories up to a repository root are discovered per the vendor's documentation, but were not tested. |
| Teardown | Closing stdin ended all three processes within about 50–110 ms, with none left. |
| Codex's own sandbox (`codex sandbox -P :read-only` / `:workspace`, run by hand with a throwaway `CODEX_HOME`) | Enforces writes as Codex does, but both profiles also block network. agy's process needs network and writes its state under `~/.gemini`. |
| Profile location | The cached login, conversations and config live under `$HOME/.gemini/` (`antigravity-cli/`, `config/`). `GEMINI_HOME` did not move them; only logs followed `--log-file`. |

## Why this is a refusal

Codex workspaces are routinely written by the model through Codex's own shell. A hooks file in the workspace's `.agents` directory runs on the next session start, or before the next model call, outside Codex's sandbox. Per the vendor's documentation, the same applies to `.agents` directories up to the repository root. Checking for such files beforehand is racy and incomplete.

The minimum boundary is therefore OS containment of agy's whole process tree. It must match the thread's file permissions, keep agy's state directory writable, and allow network only for Google's endpoints. Codex's built-in profiles block all network, and a profile that allows agy's network would also give its hooks network. That boundary has not been built or proven, so Model Bridge keeps Antigravity off and says why in Home.

## Linux whole-process boundary (built after this qualification)

`harness-sandbox.mjs` runs agy in bubblewrap. It mounts only an allowlist:
- `/usr`, `/etc` and their links, agy's own install directory, Node and the relay, all read-only;
- the workspace, read-only;
- agy's own state (`~/.gemini`), writable;
- a private `/tmp`.

The sandbox root is remounted read-only. There is no network but a Bridge proxy that admits CONNECT to `daily-cloudcode-pa.googleapis.com` and `oauth2.googleapis.com` only, and Bridge's MCP endpoint. A private PID namespace ends every child with the sandbox.

Re-measured with the existing login (`scripts/live-antigravity.mjs`, and `qualify-antigravity.mjs` with `PROBE_SANDBOX=1` and a hostile `SessionStart` hook):
- The hook ran. It could not write the workspace. It could not reach `example.com`, the host's Docker socket, another tool's credential directory or `/run`.
- agy itself signed in, listed this account's models, made the Bridge MCP call, cancelled within 8 ms and was torn down with nothing left.
- agy also tried `www.googleapis.com` and `aicode.googleapis.com`. Both were refused without breaking a turn.

An earlier version bound the whole root read-only. A review measured that host Unix sockets stayed reachable, so the mount set is now an allowlist. Tests now check that host sockets and foreign credential files are unreachable.

Still not done:
- the adapter (`antigravity.mjs`) is not wired into chat routing;
- the macOS boundary does not exist, so Antigravity is refused there;
- approval mapping per Codex sandbox and approval combination is not tested.

## What would change this

- An official agy option that disables workspace hooks and other executable customizations for a session, verified natively.
- Or a proven OS boundary around the agy process tree with the properties above, plus an approval mapping test against Codex for each sandbox and approval combination.
- A Bridge-owned Antigravity profile (`--gemini-dir`) with its own sign-in, so the agent definition and config never live in a user workspace or in the person's own `~/.gemini`. This needs a fresh owner sign-in through the proper flow.

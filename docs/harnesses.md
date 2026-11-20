# Harnesses

Model Bridge sits beneath the unmodified Codex desktop. A **harness** is the runtime that executes a chat's turns. Codex stays the tool, sandbox and approval host for every harness that runs here.

| Harness | Transport | Runs in Bridge | Why |
| --- | --- | --- | --- |
| Codex | Codex app-server (native) | Yes | Native; Bridge does not change it. |
| Claude Code | `@anthropic-ai/claude-agent-sdk` 0.3.325 | Yes | No native tools: every action goes through the Codex MCP tools, so Codex's sandbox and approvals apply. |
| Custom Responses endpoints | Codex app-server with a Bridge provider | Yes | Native Codex execution against the saved endpoint. |
| Gemini (Antigravity) | ACP, `agy acp` (1.5.0 or newer) | No | agy runs its own shell and file edits. ACP permission prompts are not a sandbox. It stays off until a boundary matching the Codex permissions is enforced and proven. |
| Cursor | `@cursor/sdk` | No | The SDK reports no command or file approval support. |
| Muse Code | `@muse-code/sdk` | No | Not qualified. |
| Grok, fx, Kiro | ACP | No | ACP agents with their own tools; not qualified. |
| ACP registry agents | ACP | No | Each brings its own tools; not qualified. |
| Pi | Pi RPC | No | Not qualified. |
| OpenCode | `@opencode-ai/sdk` over HTTP | No | Runs its own tools and server; not qualified. |

The non-running routes are the ones pinned T3 Code (`pingdotgg/t3code` `df09ced`, MIT) uses. Home lists them under **Connect more** with what is actually known:

- whether the runtime was found on `PATH`. It is never run, so a found runtime is not "ready".
- that sign-in and models are unknown;
- that execution is not qualified, and why.

Home offers no action for them, and Bridge never puts them in the model picker.

## Route identity

A route is *(harness, connection, model)*. A model of a non-native harness is always named `bridge-harness/<harness>/<connection>/<model>`. Antigravity, for example, can serve `claude-*` and GPT models. Under this naming those models can never be taken for Claude Code or Codex models. Bare Claude names (`opus`, `sonnet`, `haiku`, `claude-*`) keep resolving to Claude Code for existing chats. Bridge refuses a `bridge-harness/…` model on every model-carrying request before any host or SDK sees it.

## Claude Code lifecycle

- Each turn's SDK query spawns its CLI through the SDK's public `spawnClaudeCodeProcess` hook, so Bridge owns the process.
- A chat is released only after that process has exited. Bridge waits 5 s, then kills the process and waits again. This applies to the next queued turn, an immediate resend after Stop, and the history checkpoint. None of them overlaps the previous process on the same session.
- Stop now completes when the process has exited. Measured live, that takes about 1.9–2.0 s mid-stream: the SDK's own graceful close, stdin end, then SIGTERM after about 2 s. Bridge keeps this window so the CLI finishes writing the session that the next turn resumes. Until then the chat refuses a new message as still running.
- A failed CLI's last stderr lines (bounded) are appended to the turn error, as the SDK does for its own spawn.
- A CLI that sends no first message within 60 s (`BRIDGE_CLAUDE_BOOT_MS`) fails the turn with a clear error instead of holding it. The model-list probe has the same bound.
- Bridge keeps one query per turn and does not keep live queries between turns. The measurements below show why.

## Measurements (Linux VM, not desktop)

`scripts/benchmark-claude.mjs --run` measures live inference. It uses Claude Code 2.1.306, Haiku, no tools, and an identical prompt and settings in both modes. Each mode's first turn starts a fresh child (cold); later turns are warm. Times are in milliseconds from the moment the turn is asked.

| SDK | Mode | Init (cold / warm) | First text (cold / warm) | Process tree RSS |
| --- | --- | --- | --- | --- |
| 0.3.296 | Query per turn (Bridge) | 872 / 661–666 | 2466 / 2164–2863 | ≈266 MiB while a turn runs, 0 between turns |
| 0.3.296 | Persistent live query (T3 pattern) | 671 / 10–16 | 2489 / 1592–1614 | 233 MiB idle per kept chat, 260 MiB peak |
| 0.3.325 | Query per turn | 917 / 690–746 | 2443 / 2197–2406 | ≈265 MiB while a turn runs |
| 0.3.325 | Persistent live query | 636 / 10–15 | 2362 / 2384–2787 | 234 MiB idle, 260 MiB peak |

A persistent query avoids about 0.65–0.9 s of CLI start per warm turn. Model latency is noisy and often larger than that saving. Each kept chat costs about 233 MiB while idle. Reusing a query would also need the per-turn MCP server and system prompt moved out of the turn, plus a reuse key covering permissions and tools. Not measured: the macOS desktop, Codex MCP tool calls, long histories, and T3 Code itself on the same machine. No parity with T3 is claimed.

## Known limits

- **Antigravity, observed natively** (1.5.13, installed by the coordinator; no sign-in, no session, throwaway homes):
  - `initialize` answers in about 0.3 s and offers `oauth-personal`, `oauth-business`, `gemini-api-key` and `agent-platform` (ADC).
  - Sessions support resume, load, list and close, but not rewind. The agent supports appending to the system prompt.
  - The server log goes to `$HOME/.gemini/tmp/…` even with `GEMINI_HOME` and an absolute `--app-data-dir`. With `--log-file` inside the profile, nothing is written to `$HOME` or the workspace.
  - `agy acp` offers `--agent`, `--process-per-session`, `--ide-mcp-port` and `--sandbox`. It has no per-session `--settings`; only the plain CLI does.
- **Antigravity, not yet observed:** what a session writes to the workspace, whether a custom agent's tool allowlist really leaves only MCP tools, and what `--sandbox` enforces. These need a signed-in session. Until then they come only from T3's integration and Google's docs, and are not enforcement evidence.
- `antigravityLaunch()` prepares the Google-account route:
  - its own profile through `GEMINI_HOME`, with the log pinned inside it;
  - every other ambient `GEMINI_*`, `GOOGLE_*`, `CLOUDSDK_*` and Vertex variable dropped;
  - no `--sandbox`, which can silently do nothing.

  Nothing calls it yet.
- Native Mac desktop behaviour after these changes needs the desktop owner's run.

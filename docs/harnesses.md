# Harnesses

Model Bridge sits beneath the unmodified Codex desktop. A **harness** is the runtime that executes a chat's turns. Codex stays the tool, sandbox and approval host for every harness that runs here.

| Harness | Transport | Runs in Bridge | Why |
| --- | --- | --- | --- |
| Codex | Codex app-server (native) | Yes | Native; Bridge does not change it. |
| Claude Code | `@anthropic-ai/claude-agent-sdk` 0.3.325 | Yes | No native tools: every action goes through the Codex MCP tools, so Codex's sandbox and approvals apply. |
| Custom Responses endpoints | Codex app-server with a Bridge provider | Yes, in the isolated preview | Native Codex execution against the saved endpoint; see the README for the preview's limits. |
| Gemini (Antigravity) | ACP, `agy acp` (1.5.0 or newer) | Linux: yes, once turned on in Home. macOS: not yet | It runs inside Model Bridge's process boundary with only the Codex tools Bridge supplies, because a workspace's own Antigravity hooks would otherwise run commands outside the Codex sandbox. macOS needs its own boundary, which is not qualified yet. See [the qualification](antigravity-qualification.md). |
| Cursor | `@cursor/sdk` | No | The SDK reports no command or file approval support. |
| Muse Code | `@muse-code/sdk` | No | Not qualified. |
| Grok, fx, Kiro | ACP | No | ACP agents with their own tools; not qualified. |
| ACP registry agents | ACP | No | Each brings its own tools; not qualified. |
| Pi | Pi RPC | No | Not qualified. |
| OpenCode | `@opencode-ai/sdk` over HTTP | No | Runs its own tools and server; not qualified. |

The non-running routes are the ones pinned T3 Code (`pingdotgg/t3code` `df09ced`, MIT) uses. The connection manager Home (the provider-bound Home; the default diagnostic Home has no connection list) shows them under **Connect more**, each with what is actually known:

- whether the runtime was found on `PATH` or in the usual install folders, and its minimum version. It is never run, so a found runtime is not "ready".
- that sign-in and models are not checked;
- that it is not available in Bridge, and why.

Home offers no action for them, and Bridge never puts them in the model picker.

## Route identity

A route is *(harness, connection, model)*. A model of a non-native harness is always named `bridge-harness/<harness>/<connection>/<model>`. Antigravity, for example, can serve `claude-*` and GPT models. Under this naming those models can never be taken for Claude Code or Codex models.

`thread/start`, `thread/resume`, `thread/fork`, `thread/settings/update` and `turn/start` refuse a `bridge-harness/…` model before any host or SDK sees it. The check covers both `model` and the collaboration mode's model, and the prefix in any letter case.

An Antigravity route executes only where Antigravity is qualified and turned on: a new chat on one of its models, or a request on that chat that names its own model. Every other harness route is refused. An Antigravity chat refuses any other model on every model-carrying request, so a router never reads it as a switch. Claude Code and Codex are still chosen by model family, and bare Claude names (`opus`, `sonnet`, `haiku`, `claude-*`) keep resolving to Claude Code. A further harness still needs the adapter refactor the architecture reviews asked for.

## Turning a harness on

In the connection-manager Home, the Gemini (Antigravity) row offers **Turn on** where its boundary is supported (Linux) and `agy` is found. The choice and the resolved runtime path are stored in Bridge's own connection store (`harnesses.json`). Bridge then offers the account's models in the model list for new chats and runs them. **Turn off** stops new chats; existing chats keep their history.

Sign-in is agy's own flow: run `agy` once and sign in with Google. Bridge never sees the password and never copies a profile. `BRIDGE_AGY` exists for development only.

## Child chats and the mailbox

A Codex chat that has Bridge's `codex_bridge_sessions` tools can create a chat on another runtime with `manage create`. That works from a GPT-first chat, and `read models` lists what is available.
- **Same boundaries:** the child gets the caller's workspace and permissions, and exactly the caller's desktop tools as the desktop gave them. If Bridge did not see them, it says so.
- **Child to parent:** the child answers with `mailbox report`, sending a question, progress or a result. Messages are deduplicated by requestId, bounded and untrusted.
- **Parent to child:** the parent's `read wait` returns as soon as the child reports or finishes. Its next turn carries an untrusted pointer to unread messages. Nothing starts, steers or wakes a turn by itself, and creation is capped at two levels.
- **Shared core:** Claude Code and Antigravity children use the same tools, mailbox and permission checks.

Evidence (Linux, `scripts/live-orchestration.mjs`, the real Codex app-server on this machine's own login):
- A `gpt-6-luna` chat at low effort created a Gemini 3.8 Flash child, waited, read its mailbox question, replied, and read the answer.
- That run used 2 GPT turns and 2 Gemini turns.

Not yet observed on a Mac:
- whether the desktop renders the created chat;
- whether its desktop tools work for a thread the desktop did not start;
- whether a browser page then opens visibly.

## Claude Code lifecycle

- Each turn's SDK query spawns its CLI through the SDK's public `spawnClaudeCodeProcess` hook, so Bridge owns the process.
- A chat is released only after that process has exited. Bridge waits 5 s, then kills the process and waits up to 2 s more. That covers the next queued turn, an immediate resend after Stop, and the history checkpoint, so none of them overlaps the previous process on the same session. The exception is a child that is still not confirmed gone after the kill: Bridge logs `turn.child_exit unconfirmed` and continues.
- Stop completes when the process has exited. Measured live, that takes 1.9–2.1 s mid-stream (four samples). It is the SDK's own graceful close: stdin ends, then SIGTERM after about 2 s. Bridge keeps this window so the CLI finishes writing the session that the next turn resumes.
- Until then nothing can start or steer the chat. `turn/start` is refused as still running, while `turn/steer` and `thread/queue/start` are refused as no longer active. A message can still be queued. It is not started when the interrupted turn ends; it runs once, after the next completed turn. A partial wait for `turn/start` only was tried and removed, because it made these inconsistent. How the unmodified desktop shows this window is not yet observed on a Mac.
- A failed CLI's last stderr lines (bounded) are appended to the turn error, as the SDK does for its own spawn. Bridge reads them after the stream has closed, waiting at most 0.5 s.
- A CLI that sends no first message within 60 s (`BRIDGE_CLAUDE_BOOT_MS`) fails the turn with a clear error instead of holding it. The model-list probe has the same bound. Its child is reaped in the background, and the list is not held until it exits.
- Bridge keeps one query per turn and does not keep live queries between turns. The measurements below show why.

## Measurements (Linux VM, not desktop)

`scripts/benchmark-claude.mjs --run --rounds 4` measures live inference. It uses Claude Code 2.1.306, Haiku, SDK 0.3.325 (as shipped), no tools, and an identical prompt and settings in both modes. Each mode's first turn starts a fresh child (cold); the other three are warm. Times are in milliseconds from the moment the turn is asked.

| Mode | Init, cold / warm | First text, cold / warm | Process tree RSS |
| --- | --- | --- | --- |
| Query per turn (Bridge) | 932 / 612–642 | 2411 / 2089–2318 | about 265 MiB while a turn runs, none between turns |
| Persistent live query (T3 pattern) | 590 / 12–21 | 2272 / 1901–1935 | 233 MiB idle per kept chat, 310 MiB peak |

- **Stop to exit, mid-stream:** 1875–2096 ms.
- **Model list:** 546–558 ms; the probe child then exits 0.4–0.5 s after close. This involves no inference.
- **Close to exit after a finished turn:** 399–438 ms.
- **Prompt join on both SDKs:** the `user_message_uuid`/`user_message_uuids` join is present on assistant and `message_start` frames.

Earlier two- and three-round runs, on SDK 0.3.296 and 0.3.325, gave the same picture with more spread. On 0.3.325, one warm persistent-query sample was slower than the per-turn ones.

A persistent query saves about 0.6 s of CLI start per warm turn, and here 0.2–0.4 s of first text. Each kept chat costs about 233 MiB while idle on a 4 GiB VM. Reusing a query would also need the per-turn MCP server and system prompt moved out of the turn, plus a reuse key covering permissions and tools. Bridge therefore keeps one query per turn.

Not measured: the macOS desktop, Codex MCP tool calls, long histories, and T3 Code itself on the same machine. No parity with T3 is claimed.

## Known limits

- Antigravity was qualified signed in on 20 November and refused, because a workspace's own hooks run outside Codex's sandbox. A Linux whole-process boundary and an MCP-only adapter now exist and are measured live; see [the qualification](antigravity-qualification.md). The adapter is not yet wired into chats, and macOS has no boundary. Gemini Neon is not in this account's server catalog, which matches the owner-reported free plan.
- `antigravityLaunch()` prepares the Google-account route. It turns auto-update off, forces file credential storage, moves only the server log, drops every ambient `GEMINI_*`, `GOOGLE_*`, `CLOUDSDK_*`, `AGY_*` and Vertex variable, and does not pass `--sandbox`. It does not isolate the profile: on 1.5.13 the login and state stay under `$HOME/.gemini`, and `GEMINI_HOME` moves nothing. An own profile would need `--gemini-dir` and its own sign-in. Nothing calls this function.
- Native Mac desktop behaviour after these changes needs the desktop owner's run.

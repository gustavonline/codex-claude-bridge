# RC13 carry-forward evidence (20 November)

This is the detailed evidence behind PR #31. That PR is the preserved RC13 source (`1dc8483`, tree `431fe5a`) plus focused commits. Harness behaviour, measurements and limits are in [harnesses](harnesses.md). The Antigravity decision is in [the Antigravity qualification](antigravity-qualification.md).

## Baseline: 45 of 755 failures, each classified before fixing

| Count | Cause | Classification | Fix |
| --- | --- | --- | --- |
| 19 | `native_permissions_unconfirmed` / `handoff_queue_pending` refusals | Stale fixture | The shared fixture modelled pre-0.166 responses. Codex 0.166/0.167 report `cwd`, `reasoningEffort`, `approvalsReviewer`, `activePermissionProfile` and `runtimeWorkspaceRoots` (`generate-json-schema --experimental`), and they echo `thread/name/set`. The tests now assert RC13's hand-off to a private child, and its refusal while a queue is pending, byte for byte. In-place scenarios run on Bridge's own un-routed change. |
| 15 | Home tests | Stale UI | They drove the v7 dashboard; the shipped page is v11. Every no-write-before-Save, no-replay and same-scope-recovery assertion is kept. |
| 2 | 5 vs 6 MCP tools | Intended | The sixth tool is `read_history`, the bounded reader of the chat's own history. The assertions now check exact names. |
| 2 | Extra dynamic tool on native starts | Intended | Every new native thread gets `codex_bridge_history`. |
| 4 | `secret_storage_unavailable` | Host dependency | The tests probed the host's `/usr/bin/secret-tool`. The probe is now injectable; production behaviour is unchanged. |
| 3 | Catalog codes, 2 MiB limit, `turn/start` model change | Intended | 401/403/429 now return specific codes. A model change is a guarded hand-off; provider and config overrides stay refused. |
| — | Transition notice repeated | Stale fixture | The fake SDK stream lacked the public `user_message_uuid` join. |

## Bug found while porting

`thread/resume` with a GPT model flipped a queued Claude chat in place, and the Claude-queued message then ran on GPT. A resume that names a model now takes the guarded hand-off: it is refused intact while a queue is pending. Regression test: `R-RESUME` in `test/connection-regressions.test.mjs`.

## Reviews (Fable 5.2 High, read-only, immutable heads)

| Head | Score | Outcome |
| --- | --- | --- |
| `1147ab1` | 7/10 | Baseline 45 → 0 confirmed by running (base 710/45, head 768/0). Resume fix and lifecycle sound. Nine findings, fixed in `930f006`. |
| `930f006` | 8/10 | Refusal bypass, bundle pin, stderr race and model-list wait closed. Seven findings, fixed in `4a2cd11`. |
| `4a2cd11` | 8.5/10 | Five of six fixes landed. The abort guard did not match the SDK's `AbortError`, and the Stop wording was imprecise; both fixed in `94a6f82`. |

## Checks (Linux, Node 22)

- `npm run check`: 768/768, Python compile, package contract.
- `npm run bundle -- --pin` as the final commit, then `bundle --check` and `npm run test:distribution`: 103 dependency integrities, packaged Home over stdio.
- **Live Claude Code** (2.1.306, SDK 0.3.325): the prompt join is present, owned children exit, and Stop takes about 2 s.
- **Not run:** the macOS desktop and live GPT turns. CI's full path waits for the `full-artifact-qualification` label.

# Operation and releases

The installed CLI lives under `~/.local/share/codex-claude-bridge`. Its paths-only settings are in `~/.config/codex-claude-bridge/settings.json`. The default isolated profile is `~/Library/Application Support/Codex Claude Bridge`; adopted profiles keep their original location.

## Diagnose

```sh
codex-claude status --json
codex-claude doctor codex://threads/01234567-1234-5678-1234-123456789abc
codex-claude logs codex://threads/01234567-1234-5678-1234-123456789abc
codex-claude check
```

Doctor writes a private metadata report with run/thread/trace IDs, pending calls, model changes, tool outcomes, queue events and categorized failures. Logs rotate and omit prompts, arguments, credentials and raw error text. Raw desktop logs and local transcripts can contain private content; do not attach them to public issues. Log success is not visual proof of a panel opening.

If a process stops during an external action, inspect its real destination before retrying. A tool may have completed after the caller lost its result. A failed/interrupt turn pauses its queue. A corrupt chat file stops state loading and reports the failure; preserve it for recovery rather than deleting it to make startup appear healthy.

A session-tool fork can conservatively report an uncertain receipt even when model selection or history preparation failed before native dispatch. Inspect the session list and the original error before using a new request ID; the receipt is not proof that a child exists. The bridge does not automatically repeat the fork.

## Upgrade and recover

Run the versioned installer from a downloaded release or built bundle. It verifies the npm archive checksum, stages dependencies, runs compatibility checks, and only then stops an idle installation and replaces it. The previous package remains at `~/.local/share/codex-claude-bridge.previous`. It preserves source configuration, profile and conversations. It refuses concurrent installation and busy shutdown. Do not update from the bridge chat that is actively running the installer.

Stop checks are made by whichever CLI runs them:

- **0.3.0-rc.9 and later stopping its own version.** Stop counts work in every live Bridge process of the app. Each process keeps its own runtime record, matched by process ID and start time. The record also states the process's scheduling nice value. If a record can be neither updated nor invalidated, the process raises its own nice value by one, and stop reads the live value from the process list. A mismatch is unverified immediately, even though the older record is still on disk. Every desktop request counts as possible work while it is in flight, including requests the Bridge does not recognize. The exceptions are a short list of plain reads and three cancellations: interrupt, command termination and deleting a queued message. Each such request is recorded before it is forwarded, and refused if that cannot be done. A turn that Codex starts by itself cannot be refused, but it is covered by the same signal. A live Bridge process is also unverified if it has no valid record, has a nice value of 19 or more, has a record more than 20 seconds old, or cannot read or set its own nice value. Unverified activity is never stopped.
- **Upgrading from 0.3.0-rc.8 or earlier.** The installer stops the app with the *installed* (old) CLI before replacing it, so that stop uses the old check. The old check can miss a turn that is still being prepared when the app runs more than one Bridge process. Staging and checking the new package does not change this.
- **A newer CLI meeting an older live Bridge process.** That process never writes a runtime record, so it stays unverified until it exits. Finishing its chats or retrying does not change the result.

For an upgrade from 0.3.0-rc.8 or earlier, neither the chat list nor the older CLI shows that the installation is quiet. A waiting queued message may not be visible. The older `status` and `stop` check only the recorded desktop process, so "not running" does not rule out another Bridge process for the profile. Run the installer only for an installation that is already stopped, established independently:

- no isolated desktop and no live Bridge process for that profile;
- every saved chat readable, with no running, queued or starting work;
- no launcher start or stop in progress.

The installer's stop step then has nothing to stop. If anything is live, or any of this cannot be checked, hold the upgrade. A visibly empty chat list, an idle reading from the older CLI, missing or rotated logs, and a retry do not establish it.

The installer moves the current package into `.previous` and replaces whatever was there. Before upgrading, keep a private copy of the installed program, and of any older package you rely on for recovery, on the same Mac. That copy holds program files only, not profiles, chats or credentials.

If setup fails after replacement, the installer restores the prior package and reports the failure. If a later runtime regression appears, stop the idle app and reinstall the last known-good release. Profile data is separate; do not delete it as part of rolling back a package. Recovering from a future incompatible data format may require that release's migration guidance.

Codex and Claude Code use their normal update channels. SDK upgrades are deliberate package changes with pinned versions. After an app/runtime update, the next start reruns public protocol compatibility checks and refuses to start the work window if they fail.

Removing the skills plugin does not delete the CLI or chats. To uninstall, first stop the idle isolated app, then remove its package directory and managed CLI/launcher shortcuts. Preserve settings and profile unless the owner explicitly requests their removal. Normal Codex remains independent.

## Build and release

```sh
npm ci --ignore-scripts --omit=optional
npm run check
npm run bundle -- --pin
npm run bundle -- --check
npm run test:distribution
```

`dist/` contains the npm tarball, a standalone installer ZIP, a plugin ZIP with that exact tarball, and SHA-256 checksums. `--pin` updates the source plugin's `bundle.json` so a source marketplace installation downloads only the exact release archive. When available, the installer uses the existing GitHub CLI login for private release access; bundled ZIPs need no separate GitHub download. Pin after final runtime/doc edits; commit the pin. `--check` rejects stale integrity metadata. Both bundles are generated from the same installer and plugin source. `npm-shrinkwrap.json` is the single dependency lockfile and is shipped in the runtime tarball. Distribution tests install the archive offline into an empty prefix and compare every non-optional dependency version and integrity to that lock.

The installer extracts the verified archive into its staging directory and runs `npm ci` against the shipped lock. Do not replace this with `npm install <tarball>`: npm can re-resolve peer dependencies when installing the bridge under another package. The distribution check runs the same staging script, checks the actual on-disk versions and npm integrity records, and invokes the resulting CLI.

The source marketplace is `.agents/plugins/marketplace.json`; portable and legacy Codex plugin manifests share identity, version and presentation. There are two skills and one plugin MCP server: the read-only Home view (`home/server.mjs`), registered by the plugin's root `mcp.json`. Home speaks the MCP Apps `ui/initialize` handshake from its served page, reads no Bridge installation, settings or chats, and shows what it cannot confirm as unknown (see Support). A tool call, resource fetch or synthetic-host test is not proof that Codex displays it; earlier isolated Home revisions have owner visual acceptance (see Support), while each later candidate must be identified and qualified separately.

Ordinary CI, on pushes and pull requests, runs only source and CI-guard checks on Linux/macOS with Node 22/24. It does not build or validate packages, and its required `checks` result stays failing until full qualification passes. Full package and final-artifact qualification runs only when the repository owner newly adds the `full-artifact-qualification` label to a pull request from this repository, for that event's merge commit; a later head needs a fresh label action. A manual `full-artifacts` run is a diagnostic on the selected branch and does not qualify a pull request. The release workflow accepts a matching `v<package version>` tag and creates a draft prerelease containing tested assets. It never publishes to npm, touches a desktop installation or runs live model tests. Review the draft against its exact revision before publishing it. A workflow file is not proof that branch protection or a hosted check is enabled.

For a new release, update runtime/lockfile and both plugin manifest versions together. Regenerate the pin, run checks, review the immutable candidate, merge through required CI, then tag it. Keep a real macOS runtime check and the small visual acceptance separate from portable CI/Z13 review.

`plugins/codex-claude/bundle.json` pins the archive built from the source it is committed with. In a source patch on top of an already built archive, such as the private RC13 startup-config patch, it still names the original archive's SHA-256 and is stale for the patched runtime. Rebuild on a host with the pinned dependencies and run `npm run bundle -- --pin` so the pin names the candidate's own archive; do not edit the hash by hand or pin an archive that has not been built.

## Staged main-app trial (source preparation; NOT RUN)

This is a procedure for the repository owner and the Mac operator, written from the source of the helper (`cli.mjs`, `launch.py`) at the revision this document ships with. Nothing here has been run on a Mac. It is a trial route using an explicit, reviewed runtime and helper, not the final ordinary-launch activation experience (an ordinary Dock, Spotlight or login launch stays GPT-only; see Architecture). It does not replace the installed RC10, does not use the composite `install.command` (it can download, sign in and delete a previous package), and adds no model, proxy, daemon or profile copy. Values marked **live** exist only on the Mac and must be read there; none is assumed or invented here.

**What the helper reads and writes, exactly.**
- `codex-claude primary` first calls `configuration()`, which always reads the global Bridge `settings.json` (`~/.config/codex-claude-bridge/settings.json`; an unreadable file stops it), even when `--app`, `--source` and `--state` are given. It writes that file only for `setup`, and for `start`/`restart` when none exists; `primary` never does.
- `launch.py --check --primary` is not metadata-only: it requires the `--source` directory, parses `<source>/config.toml` with `tomllib`, runs `claude auth status --json` (the Claude CLI reads its own login; the helper keeps only login state, method and provider and exports no token), and runs `--version` on the app's Codex CLI, Claude and the bundled Node.
- The compatibility check then runs unless the last report passed for the same versions and scope. It uses a fresh synthetic profile in a temporary directory of the operating system (copies nothing from the normal profile) and writes `<state>/diagnostics/compatibility.json`.
- `launch.py --primary` verifies the app's identity (`com.openai.codex`), its code signature (`codesign --verify --strict`) and its bundled CLI, takes `<state>/primary/launcher.lock`, creates `<state>/primary/{threads,logs,runtime}` (mode 0700) and a private wrapper `<state>/primary/codex-bridge`, and lists processes (`ps`). It refuses while any copy of the app runs or an earlier primary Bridge is still running. It then runs `open -a <app> --env CODEX_CLI_PATH=<wrapper>` with every `CODEX_*` and `BRIDGE_*` variable of its own shell removed, and waits up to 30 s for a Bridge record under `<state>/primary/runtime` whose process start matches the app's child. If none appears, the app stays open GPT-only and the command reports it.
- It changes no Codex configuration or history itself. Claude chats the person creates afterwards are written by Codex into the normal history, and the Bridge's own records go under `<state>/primary`. How such a chat behaves when later opened without the Bridge is not established in source; treat it as unqualified and protect the history first.
- If a `connections.json` exists in `<state>/primary` (source only; nothing creates it yet), it can disable Claude Code or hide models for that launch. A missing file changes nothing; an unreadable one refuses new Claude work until fixed. Queued Claude messages wait for an explicit queue start after any disable, including one the Bridge was not running to see; re-enabling, restarting or sending an ordinary message does not start them. Replacing or deleting the file counts as a change for those queues too, but restoring an older copy of it can make an old queue match again. A chat saved before this change with queued Claude messages waits once for an explicit start, even when there is no `connections.json`. With an earlier-layout file (or while the file is unreadable), each queued message needs its own explicit start, on Claude and on GPT. On an earlier-layout file a disable is refused with an error, and the log shows `connections.record_failed` for each `model/list` and refresh. The saved reason of such a pause reads `provider_disabled` even when nothing was disabled: the log line `queue.pause_marked` says whether the cause was a disable, a changed generation or an unknown one. The session tool's `start_queue` counts as an explicit start (unchanged). A disable is refused (with an error) once the file's disable counter reaches its bound of 2^31 - 1. Do not delete a `connections.lock` unless no Bridge update is running.
- GPT keeps its native path; the wrapper sends `app-server --print-startup-config` and non-`app-server` calls straight to the original CLI. GPT behaviour with the Bridge in the path is proven only by the repository tests, not by this procedure.

**Source risks to check before relying on it.**
1. `--source` defaults to `~/.codex` while the app's real profile is whatever the running app uses (**live**). Pass `--source` explicitly with that live path; otherwise the preflight parses a different `config.toml` than the one the app uses. The `open` launch passes no `CODEX_HOME`, so the app starts with the profile its own launch would give; compare the profile of the new process with the one recorded before.
2. `--state` defaults to `~/Library/Application Support/Codex Claude Bridge`, shared with the RC10 separate test window. Use a task-local `--state` so that the trial writes nothing there, and pass `--app` explicitly (**live**).
3. The helper refuses while Codex runs, and cannot be run from a chat inside that Codex. The person quits it, then runs the helper from Terminal, so the operator working in that app loses it for the duration.
4. Calling `launch.py --primary` directly skips `--check --primary` and the compatibility check. If used, do both first by hand against the same flags.
5. The Home plugin install (below) is a separate write to the normal Codex configuration made by Codex's own plugin command. The helper does not need the plugin and the plugin does not need the helper.

**Protect before any change.** Do this while every chat is idle, with the app still running (**live**: the profile and desktop data paths the running app actually uses, read from the running process; never assumed).
1. Create a task-local private directory (mode 0700) outside the profile, not shared and not committed.
2. Record `sha256` and size of each selected file: `config.toml`, personal instructions and the history/state files with their `-wal` and `-shm` sidecars. Do not copy `auth.json` or any credential, and do not clone the profile.
3. For each history database take a consistent copy with SQLite's online backup (`sqlite3 <db> ".backup <copy>"`), not a raw copy of the main file; copy plain files after the app is idle. Record the same hashes of the copies and the time.
4. A backup is a record of a moment. It is never restored over live files.

**Adopt (owner at the Mac, with Root's artifacts).**
1. With the frozen offline artifacts and the qualified dependency set, install the reviewed runtime into a task-local prefix (**live**), not over the RC10 prefix. The trial then runs that prefix's `cli.mjs`; `launch.py` and the wrapper point at that same prefix.
2. Quit Codex once all chats are idle. Do not quit while a turn runs.
3. In Terminal, run `node <prefix>/node_modules/codex-claude-bridge-local/cli.mjs primary --app <live app path> --source <live profile path> --state <task-local state> --json`.
4. Optionally add the frozen candidate's plugin ZIP with the same official plugin marketplace command used in the isolated test (copy its exact invocation from that run's record; it is not reproduced here). This edits the normal `config.toml`, so it comes after the backup.
5. Check with `... primary status --json` and the app's own model picker. A tool call, a status line or the Home view is not acceptance of Claude in a chat.

**Roll back (no overwrite of new activity).**
1. Quit Codex once idle and open it the ordinary way. With no `CODEX_CLI_PATH`, it is GPT-only and the Bridge ends with it. No file was changed by the helper outside `<state>`.
2. Plugin: remove it with Codex's own plugin command. Restore `config.toml` from the record only if its hash still equals the one taken right after step 4; otherwise reverse only the plugin's change by hand and keep the rest.
3. History: leave it in place. Restore a database from the backup only if its current hash equals the hash recorded after adoption and no chat has been added since; otherwise keep the live files and export what is needed.
4. Delete the task-local state and prefix only after the owner agrees. Old evidence is not cleaned up here.


## Synthetic Home controls (source candidate)

This procedure prepares a new test store only. It neither installs a plugin nor activates a model provider. Do not run it against an existing directory, the normal profile, RC10 or the accepted b19f629 installation. No npm, account, login, token copy, model inference or network is required. Use the already qualified Node toolchain and canonical absolute task paths.

1. From the frozen source, run `node scripts/prepare-home-test.mjs /new/absolute/private-task-root` once. The parent must already be canonical and the root must not exist. It returns a binding path and ID triple. Partial creation on failure is retained, never overwritten or repaired automatically.
2. Start only the test MCP process: `node plugins/codex-claude/home/test-server.mjs --test-binding /new/absolute/private-task-root/home-test-binding.json`. This is newline JSON-RPC on stdio, no listener/daemon or private IPC. The ordinary plugin still starts `home/server.mjs` and stays unbound.
3. Public MCP initialize/initialized, `tools/list`, `bridge_home` and `resources/read` show `home-v5.html`. A host must advertise `serverTools` in its MCP Apps initialization reply before buttons can send `tools/call`. If it does not, leave controls disabled and retain the actual capability result; do not add tools or bypass the host.
4. Discover the **fixture** catalog; select Fixture Sonnet and save; disable/re-enable. Read state explicitly after an uncertain/failed response. Only the declared test store may change. No real login, inference or native model-picker availability is established. Queue/history/GPT behavior is exercised through the existing synthetic Bridge seams against this same store; no owner chat is used.

For a later native isolated UI trial, Root can prepare a task-private plugin copy whose only MCP registration points to `home/test-server.mjs` with that exact operator-bound path instead of the default server. This is a proposed separate test registration, NOT applied by this source change. Root must qualify the actual plugin copy, test-profile identity, binding, host capability and frozen source before any installation/registration/lifecycle step. The marker's synthetic profile identity must never be relabelled as native-host proof. Keep the normal app/profile and the accepted runtime/history unchanged. Do not use a persistent config/base_url/OS environment override or an ordinary-launch provider promise.

Rollback now is leaving this uninstalled source/task directory unused. For a later separately admitted test plugin, retain the old ZIP/source and use the same official test-profile-only removal/reinstall route; never restore/overwrite new chat activity or touch normal config. There is no automatic cleanup.


## Custom Responses provider trial

Source/preparation only until Root reviews the exact candidate and qualifies its isolated deployment. Keep the normal app/profile, GPT default, history and credentials in place. No installer/setup, source-profile copy or config.toml write is part of this procedure.

1. Root selects a new private task root with `node scripts/prepare-provider-home.mjs /new/private/trial-root` (optionally `--credential-bindings /protected/operator/references.json`). It creates only fixed profile/state children and a declared marker/manifest. Partial creation is retained, not overwritten. The marker is not native CODEX_HOME proof.
2. Root binds the helper's existing `BRIDGE_STATE` to `/new/private/trial-root/state/threads` and, if needed, the same protected `BRIDGE_PROVIDER_CREDENTIAL_BINDINGS`. Start the explicit Home server only through a separately qualified private plugin copy: `node home/provider-server.mjs --provider-binding /new/private/trial-root/provider-home-binding.json`. Portable/default registration stays unbound. Root verifies actual host profile, parent launch bindings and server bytes before enabling this route.
3. Open Model Bridge through its existing global/thread entrypoint (no chat prompt is required). In Add connection, supply a name and canonical Responses base URL, optionally choose a prebound credential ID, then Connect. Saving makes no network/model call. Discover/Refresh requests only that endpoint's catalog. Add/Remove models in the library, then Save slots explicitly; a connection default is separate. Empty slots hide every custom model. Until the first slot save, old stores retain their previous all-fresh offer; later discoveries never expand the saved set. Enable/Disable governs new explicit Bridge admissions and retains history. No button claims native-picker registration, authentication/inference PASS or ordinary-launch activation.
4. The generic CLI uses the same registry: `node cli.mjs provider connect --state /new/private/trial-root/state --name Example --url https://provider.example.invalid/v1`, then `provider list`, `provider refresh --provider ID`, `provider select --provider ID --model NAMESPACED_ID`, or `provider enabled --provider ID --enabled true|false`, always with the explicit state. Optional `--auth-ref ID --credential-bindings /protected/operator/references.json` is operator input; do not pass literal keys. Example DNS is a placeholder, not permission to contact it.
5. Public Bridge `model/list` preserves native GPT/Claude rows/defaults and appends enabled/fresh, slot-selected discovered models as nondefault, conservative Bridge presets under `bridge-responses/PROVIDER_ID/ENCODED_MODEL`. It uses existing Bridge paging; id/model collisions retain the existing row, and stale/disabled/unknown custom providers are omitted. This is not an upstream ModelsResponse or capability certification. Choose a returned namespaced model on a new public `thread/start`; native app-server receives the real endpoint model and thread-scoped provider definition. It does not change the configured GPT default or retarget existing chats. Root checks actual desktop list/refresh behavior, provider/model/permission readback, stream completion, tool round trip, follow-up and retained history on the exact candidate. There is no hot-refresh notification or ordinary-launch claim. Custom-provider native queue creation/start remains refused; no automatic re-enable replay.

Protected reference format (operator creates outside model-tool access): version1 JSON with a bounded `references` array of `{id, baseUrl, credentialFile}`. Paths and values come only from the operator, never a tool argument. A reference matches one exact canonical URL. The credential is a private owner0600 regular one-link token file, at most4098bytes including one optional final newline; no shell, account fallback or environment token. The fixed native helper reads it only when the native auth caller needs it. Do not put a real reference/key into source, review packets or chat. Root owns its actual private consumption and must verify model tools cannot read/invoke it with key access. Preserve refusal/partial state rather than widening permissions.

Catalog discovery refuses every redirect without sending a second request. Inference uses the selected native app-server's transport, whose redirect and credential-forwarding behavior is not established by these source fixtures. Before admitting authenticated native use, Root must establish that the selected native route does not forward the credential on a redirect; there is no private translation proxy or hidden HTTP fallback here. An endpoint's instruction-template HTTP500 is a separate compatibility failure, not evidence that its credential helper failed.

Rollback is scoped: disable the declared provider/private test registration and return to the retained test-plugin/runtime artifact only at Root's actual idle handoff. Do not delete providers, routes, chats, keys or prior evidence. No normal-profile installation, lifecycle action, merge or release is admitted by these instructions.

### Slot changes, drafts and recovery

Save slots changes only the fixed private slot setting in the declared state root; it does not change native defaults, credentials, histories or existing routes. There is no arbitrary file/path tool or profile inference. Reopen/restart reads the saved setting. Disabled/stale/removed slots are retained and shown unavailable, with explicit Remove; their picker rows return only when that same provider/model is available. Slot hiding is not access control. Native library-to-slots drag/drop changes only the draft; labeled keyboard Add/Remove buttons provide the equivalent action. Numbered near-square model tiles sit above the library. Long tile/library grids scroll with search and Save outside their scroll areas; small screens stack. Empty Add cells focus the library/search, do not save empty positions and do not impose a five-model limit. There is no slot-count hardware allocation UI.

Theme/layout/context updates retain edits. If another writer saved slots, choose Keep my draft or Use saved slots after reading status. On cancellation/timeout the outcome is unknown: do not retry a write; Read current state explicitly before another mutation. No cleanup, lock takeover, normal-profile activation or installer action is part of recovery. Root owns focused review, native consumption and Mac integration of the new v7 source.

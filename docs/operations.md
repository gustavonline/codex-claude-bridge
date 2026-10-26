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

The source marketplace is `.agents/plugins/marketplace.json`; portable and legacy Codex plugin manifests share identity, version and presentation. There are two skills and one plugin MCP server: the read-only Home view (`home/server.mjs`), registered by the plugin's root `mcp.json`. Loading and showing Home in Codex, and main-app activation, have not been tested.

Ordinary CI, on pushes and pull requests, runs only source and CI-guard checks on Linux/macOS with Node 22/24. It does not build or validate packages, and its required `checks` result stays failing until full qualification passes. Full package and final-artifact qualification runs only when the repository owner newly adds the `full-artifact-qualification` label to a pull request from this repository, for that event's merge commit; a later head needs a fresh label action. A manual `full-artifacts` run is a diagnostic on the selected branch and does not qualify a pull request. The release workflow accepts a matching `v<package version>` tag and creates a draft prerelease containing tested assets. It never publishes to npm, touches a desktop installation or runs live model tests. Review the draft against its exact revision before publishing it. A workflow file is not proof that branch protection or a hosted check is enabled.

For a new release, update runtime/lockfile and both plugin manifest versions together. Regenerate the pin, run checks, review the immutable candidate, merge through required CI, then tag it. Keep a real macOS runtime check and the small visual acceptance separate from portable CI/Z13 review.

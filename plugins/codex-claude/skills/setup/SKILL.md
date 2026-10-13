---
name: setup
description: Install or start the local Model Bridge for Codex, verify official Claude subscription login, and prepare its isolated Codex window.
---

Use this plugin's version-pinned [installer](../../install.command). Resolve its absolute path from this skill's location. It installs the bundled npm package under `~/.local/share/codex-claude-bridge`, checks Claude, and creates `~/Applications/Codex + Claude.command`. The CLI executable is `~/.local/share/codex-claude-bridge/node_modules/.bin/codex-claude`; do not rely on PATH.

Before installation, check macOS, Node >=22, Python >=3.11 and the installed Codex desktop. Reuse existing installations. If a prerequisite is missing, install it with the existing package manager within the user's installation request; do not install a new package manager as a side effect. The installer uses Anthropic's official native installer only when Claude Code is absent. Login uses `claude auth login`; the person completes that login. Never extract, copy or proxy Claude credentials. Do not print raw auth status, which includes account details.

For an existing bridge installation, run `codex-claude status --json` and preserve its profile. If adopting a known earlier prototype, pass `--state <existing-profile>` to the installer; the snapshot supplies its original Codex source. Otherwise use defaults. Installation/start is idempotent. An upgrade refuses to stop a busy app; finish or stop the work before retrying. Do not restart the app hosting your own active Claude session.

Run the bundled installer with the selected path options. It checks subscription authentication and runtime compatibility, configures only a separate Codex profile, and opens that window. The ordinary Codex configuration is the one-way source for skills/plugins/settings. No HTTP model endpoint, additional MCP server or background daemon is required. The adapter runs on stdio under the isolated app and exits with it.

Verify `codex-claude doctor` and the saved compatibility report. A successful setup must have both model catalogs, the native and Claude thread routes, authenticated Claude, and an isolated launch. Login does not prove remaining quota. Protocol checks do not prove that a browser/editor panel was displayed. Do not send test prompts into existing user chats.

Removing this skills plugin does not uninstall the separate CLI or delete chats. Stop the idle isolated app with the CLI if requested; preserve its state unless the user asks to remove it.

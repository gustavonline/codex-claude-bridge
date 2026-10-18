<p align="center"><img src="https://raw.githubusercontent.com/gustavonline/codex-claude-bridge/main/.github/assets/banner.png" alt="Codex Bridge — One workspace. More models." width="1200"></p>

# Codex Bridge

**Use Codex as your main workspace, with more choice of models.**

Keep your conversations, files, browser and tools in one place. Codex Bridge adds Claude alongside the native models in the Codex desktop app, using your installed Claude Code runtime and the official Agent SDK. Switch models within the same visible conversation, whether you are researching, writing, planning or building software.

By [Gustav Online](https://github.com/gustavonline).

- **One workspace:** the familiar Codex interface, conversations and panels.
- **Model choice:** native Codex models plus Claude through the current adapter.
- **Your ways of working:** inherit enabled skills, instructions and MCP tools as needed.
- **Continuity:** resume, fork, edit and steer conversations across supported model changes.

## Current state

An independent **macOS source preview**. It is not an OpenAI or Anthropic product, and full feature parity is not promised. See the [support matrix](../docs/support.md) for tested behavior and known limitations.

Packaged releases are still private drafts. There is no public installer release yet. Developers can inspect the source and build a local bundle:

```sh
git clone https://github.com/gustavonline/codex-claude-bridge.git
cd codex-claude-bridge
npm ci --ignore-scripts --omit=optional
npm run check
npm run bundle -- --pin
```

Requires macOS for desktop use, Node.js 22 or newer, Python 3.11 or newer, Codex desktop and your own Claude Code login. Building a bundle does not install or restart the app.

[Setup and development details](../README.md) · [Architecture](../docs/architecture.md) · [Support](../docs/support.md) · [Security reports](../SECURITY.md)

The existing CLI and package identifiers stay `codex-claude` and `codex-claude-bridge-local`. Earlier preview documentation and installers use the name “Model Bridge”.

MIT for this adapter. Codex, Claude Code and the SDK retain their own licenses and terms.

# Security reports

Report credential exposure, permission bypass or unauthorized session access
through [GitHub private vulnerability reporting](https://github.com/gustavonline/codex-claude-bridge/security/advisories/new).
Do not post credentials, raw transcripts or desktop logs in public issues.

The preview supports the current candidate only. The adapter is local and uses
the user's existing Codex and Claude Code permissions. A separate profile is not
an OS sandbox. See [architecture](docs/architecture.md) for actual boundaries
and [operations](docs/operations.md) for diagnosis and recovery.

Initial desktop preparation copies Codex/OpenAI `auth.json`, when present, into
the isolated profile with mode 0600 beneath a mode-0700 directory. It is a
one-time credential snapshot, not ongoing auth synchronization. Login/refresh
interaction between separate snapshots is unqualified; do not infer token
independence. Compatibility probes skip this copy. Live model tests require
the separate `--copy-codex-auth` opt-in and remove their private temporary copies.
The bridge never reads or copies Claude credentials.

## Release artifacts

After bundling, CI and the draft-release workflow run `scripts/check-artifacts.mjs` on the actual runtime TGZ, plugin ZIP and installer ZIP. That covers every outer entry and the nested runtime archives, within size, entry-count and time bounds.

- **What it refuses:** environment files (`.env`, `.env.*`, `*.env`), auth and credential state, logs, transcripts and history, key files and repository state, wherever they appear and regardless of Git ignore rules.
- **Supported secret formats:** private keys, GitHub, OpenAI, Anthropic, AWS, npm, Google and Slack tokens, secret-variable assignments and private local paths.
- **Allowed exceptions:** only `.env.example`, `.env.sample` and `.env.template`, whose contents are still scanned.
- **What is scanned:** entry names, retained archive metadata (tar header fields and PAX records) and contents. ZIP extra fields and entry comments, gzip header fields, directory payloads and nonzero tar padding are refused.
- **Failure handling:** a failure names the artifact, entry and category, never the matched value; supported formats in entry names are redacted. Unsupported or malformed archives, exceeded bounds and inspection errors also fail.
- **Delivery binding:** a pass records the exact bytes in `dist/ARTIFACT-CHECK.json`. The release step uploads only those files after confirming they are unchanged; a changed, added or missing file, or a missing record, stops it.

This is a packaging control, not a guarantee that no secret can exist in other forms.

Repository settings are separate and are not changed by this source. As read on 22 October 2026:
- `main` requires the strict `checks` status, also for administrators, along with conversation resolution and stale-review dismissal, and disallows force pushes and deletion.
- Repository secret scanning and push protection were disabled.

A passing workflow does not enable them. Confirm the available protections before any public release.

## Session permissions

Session mutations enforce the native approval policy and matching permissions.
Choosing `never` delegates these operations within that boundary; interactive
policies require desktop approval. This does not authenticate natural-language
intent. Shell calls preserve the resolved sandbox, never escalate it, and reject
missing permissions. A new action requiring a bridge approval prompt rejects
unknown policies rather than inheriting a more permissive default. Preapproved
MCP tools keep their separate configured approval rules.

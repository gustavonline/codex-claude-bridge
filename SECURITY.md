# Security reports

For this private preview, report credential exposure, permission bypass or
unauthorized session access directly to the repository owner through your existing
private channel. Private vulnerability reporting must be enabled and verified
before a public release. Do not post credentials, raw transcripts or desktop logs
in public issues.

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

Session mutations enforce the native approval policy and matching permissions.
Choosing `never` delegates these operations within that boundary; interactive
policies require desktop approval. This does not authenticate natural-language
intent. Shell calls preserve the resolved sandbox, never escalate it, and reject
missing permissions. A new action requiring a bridge approval prompt rejects
unknown policies rather than inheriting a more permissive default. Preapproved
MCP tools keep their separate configured approval rules.

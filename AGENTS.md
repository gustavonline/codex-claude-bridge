# Codex + Claude contributor instructions

This is Gustav Online’s independent macOS bridge beneath the unmodified Codex desktop UI. Keep it small: Codex owns its native provider, tooling and desktop; the official Claude Code runtime owns Claude execution. No model API proxy, replacement UI, private IPC bypass, credential extraction or signature spoofing.

One writer owns overlapping code. Reviewers read an immutable revision. Use temporary profiles for integration tests; never inject test prompts into existing user chats or include local auth, logs, personal instructions or histories in commits. Preserve the source profile and existing installation state. Stop/restart only when the installed bridge reports idle.

Use npm ci --ignore-scripts --omit=optional and npm test. Keep runtime dependencies pinned in the shipped npm-shrinkwrap.json; after bundling, run npm run test:distribution to check the actual installed tree. Product support and limits belong in README.md and docs; tests must cover behavior, denial, cancellation, recovery and history consistency. Native protocol proof is not desktop visual proof. No new mandatory AIOS/Factory runtime dependency: their workflows guide development only.

The owner has authorized this product’s development, scoped tests, independent Claude review, Gustav Online repository preparation and CI/release packaging. Keep unrelated Factory, AIOS and design projects read-only. Document required work that cannot be tested without the desktop owner.

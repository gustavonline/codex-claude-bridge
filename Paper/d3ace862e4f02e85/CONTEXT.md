# Model Bridge design context

**Owner direction, 9 November 2026.** Opus designs; the final design dialogue is delegated to developer + coordinator; implementation on GPT Medium to completion without further aesthetic approval stops.

What the owner wants: a calm modern ADE feel; their square chosen-model tiles on top; simple model curation (one ordered, persisted selection; 5–10 as guidance, no hard cap; no separate favorites); clear identity for the same model on different connections; Connections behind a discreet gear with breadcrumbs; truthful reasoning; honest continuity (no hidden new chat, no fork). VS Code / Zed / T3 / OpenCode references are functional only; the official T3 screenshot is the visual reference. The Ryan Shea image is a comparison matrix, not a UI; Orca material was marketing only; Paradev is not the remembered app.

**Facts that govern the drawing:**

- Saved slots control the native picker; GPT model switching in the same chat works.
- Runtime 6ee (Root-accepted): same-connection custom model switching confirmed on native 0.167; OpenRouter models[].reasoning retained; only listed levels advertised. BG9: explicit Medium → effort:medium (synthetic). Not installed; app 4215f2a untouched.
- Copy e886 (Root-accepted, 126 targeted checks pass): final providerMessages including native_runtime_stale with no reopen/restart/retry promise. Host rendering unverified (HG1).
- Native same-ID cross-provider resume is refused; the no-fork UI stays until a qualified design follow-up backed by actual backend proof. Custom↔Claude stays refused.
- MCP Apps 2026-01-26 documents displayMode and containerDimensions, not safeAreaInsets.
- Exit 90 is not a rate limit, outage or missing sign-in.

**Done:** artwork revision `45c8e115…` (Opus 00–05 revised in place, Opus 06 added; 41 Opus artboards, 3,409 Opus layers). Then revision `ba2cee1a…` fixed the four text-box overflows found by the independent PDF approximation (work/opus-modern-paper-render-check.json):
- O0: the glyph legend is a 2×2 grid with 220px label boxes; the content below it moves 26px.
- O13 Claude Code and both O14 boards: the current breadcrumb segment gets the remaining row width, so all breadcrumbs fit one 20px line.

No layers were added or removed; the non-Opus pages are byte-identical (asserted). Readback: 16 pages, counts match staging.

**Open:** native visual review of rendering/wrapping/glyph fallback; implementation in server.mjs; BG4 reset; read-only credential presence check for O21/O22; HG1–HG4 desktop checks.

Never place secrets, personal history, callbacks or owner screenshots in this Paper.

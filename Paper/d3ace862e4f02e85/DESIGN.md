# Model Bridge Home — canvas guide

Canonical product specification: ../../design.md in this project. Authoritative inputs: outputs/OPUS-MODERN-FINAL-NOV9.md (visual), outputs/OPUS-FINAL-COPY-NOV9.md (copy), outputs/OPUS-CURATION-DIRECTION-NOV9.md (function).

## Page status (9 November, final curation direction)

- **Opus 00–06**: the governing final direction, drawn by Claude Opus 5.5 High. Start at `Opus 00 · Index and direction`. Implementation is GPT Medium; no further aesthetic approval stop.
- The earlier 9 Nov Opus light direction (bare gear + Done pill, floating save bar, filter popover) is superseded. It is kept in Paper history at revision `fffd12a0…`.
- `UNAPPROVED GPT reference · 09 Nov native rows`: not a direction. Unchanged.
- `Overview`, `Current`, `01–16`, `17–27`, `28–36`, `Reference ·`: 7 November history. Unchanged.

## Opus pages (drawn)

| Page | Artboards |
| --- | --- |
| Opus 00 · Index and direction | O0: principles, status legend, board index, flows, dark/light tokens, component sheet |
| Opus 01 · Home | O1 wide dark/light · O2 compact dark/light · O3 loading · O4 first use · O4 no models · O5 couldn't update |
| Opus 02 · In picker, library and menus | O6 ⋯ menu wide dark/light · O6 compact unavailable · O7 In picker list view · O8 no matches · O9 drag · O10 keyboard + unsaved · O11 saved · O11 heading-row states |
| Opus 03 · Connections | O12 dark/light · O13 OpenRouter · O13 disconnected · O13 Claude Code (light) · O14 add endpoint · O14 validation · O15 catalog states |
| Opus 04 · OpenRouter sign-in | O16–O20 · O21 exit 90 · O21 checking · O22 missing (O21/O22 flagged NOT IMPLEMENTED) |
| Opus 05 · Errors in chats | O23 × 3 final refusals (local_requires_new_thread, cross_provider_switch_requires_new_thread, native_runtime_stale) · O24 error pattern · O24 helper message |
| Opus 06 · Reasoning and scrolling | O25 reasoning lines (6 catalog cases) · O26 one scroll surface + bottom space |

Each artboard has a caption with its O-number, theme, and status: Implemented / Proposed · not implemented / Mixed / Copy in runtime source (e886, not installed; HG1 unverified).

Direction summary: quiet T3-like tool surface; 44px header with title and discreet gear; breadcrumbs in secondary views (no Done, no X); square hairline tiles with original glyphs; In picker heading row holds count and Save/Discard; one search field + All models | In picker switch; grouped 36px rows; one anchored menu layer; Connections as grouped rows with detail pages; one scroll surface.

Composition notes: Inter approximates the system font; shadows are low-opacity offset rectangles; glyphs (cloud, terminal, route, outlined initial), gear, ⋯, search and spinner are shape-built approximations of the final inline SVG; ✓ › ▾ → × ⋮⋮ are text glyphs with unverified fallback. Regenerate by editing work/opus-curation-compose.py, running it to produce work/opus-curation-staging.json, and committing through revisioned paper_save. Never write Paper files directly.

# Model Bridge Home

Purpose: choose models in the existing Codex app, keep a small personal picker selection, and manage optional connections without losing chats, login or permissions.

Canonical editable design: [Model Bridge — Home and connections](Paper/d3ace862e4f02e85/paper.json), Paper ID `d3ace862e4f02e85`, project workspace `771987a9dec2d9d52669f05e`. Open it through OpenPaperDesign Home in this project.

**Status, 9 November (final).** The Paper opens with seven Opus pages, Opus 00–06, covering boards O0–O26 (41 artboards). They are the governing design, drawn by Claude Opus 5.5 High. The owner delegated the remaining design dialogue to developer + coordinator. Implementation runs on GPT Medium to completion, with no further aesthetic approval stops. Authoritative inputs:

- `outputs/OPUS-MODERN-FINAL-NOV9.md`: visual tokens, layout, responsive behaviour and acceptance criteria.
- `outputs/OPUS-FINAL-COPY-NOV9.md`: copy refinements, reasoning wording and glyphs.
- `outputs/OPUS-CURATION-DIRECTION-NOV9.md`: functional baseline and providerMessages.

**Superseded:**
- The earlier 9 November Opus light direction (bare gear plus Done pill, floating save bar, filter popover, "New chats only" labels). Its artwork remains in Paper history at revision `fffd12a0…`.
- `UNAPPROVED GPT reference · 09 Nov native rows`: not a direction.
- The 7 November pages, kept as history.

## Final direction

**One sentence:** a quiet tool surface. One flat, ordered selection of square tiles on top, one searchable list below, and Connections behind a discreet gear. One saved truth drives the tiles, the In picker list and the native picker.

**References.** The official T3 Code screenshot is the visual reference: dark charcoal, hairlines, 12–13px type, muted secondary text, 8–12px corners, almost no shadow, breadcrumb titles. VS Code (Manage Language Models), Zed, T3 state separation and OpenCode variants informed **function only**. The Ryan Shea image is an orchestrator comparison matrix, not a UI. Orca material was marketing only. Paradev is not the remembered app.

Principles:
1. **Quiet tool surface.** Flat surfaces, one 1px hairline, small type. No glass, logo, nested borders or extra status strips.
2. **One truth, two views.** The saved ordered selection is the tiles and the In picker list. No favorites state and no count limit; "5 to 10" is guidance. Newly discovered models are never added automatically.
3. **One menu layer, anchored.** Every ⋯ menu opens next to its trigger inside the document. Esc returns focus.
4. **Nothing jumps; nothing near the composer.** Saving lives in the In picker heading row. One scroll surface. Nothing is `position:fixed`.
5. **Catalog truth only.** Reasoning lines describe advertised levels and defaults, never a chat's value. No native picker icons are promised. No forks, no hidden new chats, no custom↔Claude switching.

### Tokens

The page stays transparent over the host. Theme comes from the documented host-context `theme`, falling back to `prefers-color-scheme`.

| Role | Dark | Light |
|---|---|---|
| surface (tiles, lists, search, menus) | `#141414` | `#f6f6f6` |
| hover | `#1c1c1c` | `#efefef` |
| active (selected segment, ✓ chip) | `#262626` | `#e6e6e6` |
| border (hairline) | `#262626` | `#e5e5e5` |
| border-strong (hover/drag) | `#3a3a3a` | `#d0d0d0` |
| fg | `#ededed` | `#171717` |
| fg-2 (all secondary text) | `#a1a1a1` | `#5c5c5c` |
| fg-3 (glyphs and ⋯ at rest only, never text) | `#6e6e6e` | `#9a9a9a` |
| primary button | `#ededed` / `#0a0a0a` | `#171717` / `#ffffff` |
| focus | `#4d8dff` | `#2563eb` |
| warning | `#e5a54b` | `#9a5b07` |
| success | `#4cc38a` | `#1a7f4b` |
| menu shadow | `0 12px 32px rgb(0 0 0/.5)` | `0 12px 32px rgb(0 0 0/.12)` |

- **Type:** system font. Title/breadcrumb 15/20/600 (−0.01em) · section 13/18/600 · body 13/18/500 · secondary and buttons 12/16 (buttons 600) · tile number 11/14/500. Counts use tabular numerals.
- **Spacing and radii:** spacing 4/8/12/16/20/24/32. Radii: tiles, grouped lists and menus 12; buttons, search, segmented control and rows 8; inner segment and ✓ chip 6.
- **Borders:** one 1px hairline. 2px only for the focus ring and the drag insertion bar.
- **Motion:** 120ms ease-out; none under reduced motion.
- **Contrast modes:** high contrast gives every surface a `currentColor` border; forced colours use Canvas/CanvasText/Highlight.
- **Remove:** glass/blur, `.panel`, `--soft`/`--accent`.

### Chrome and Home

- **Header (44px, 40 compact):** "Model Bridge" with a discreet 28px gear (label "Connections").
- **Secondary views:** breadcrumbs "Model Bridge / Connections / OpenRouter". Ancestors are links in fg-2, separators in fg-3. No Done and no X anywhere.
- **Buttons (28px):** primary, secondary (1px border) and ghost. Icon buttons 24/28.
- **Focus:** 2px outline with 2px offset. Fields use a focus border plus a 3px ring at 25%.
- **In picker heading row (32px, always present):** "In picker" and the count on the left. On the right, in reserved space: "Unsaved · Discard · **Save**", "Saving…", "✓ Saved to your model picker." (3 s), or "Changed in another window · Keep mine · Use saved".
- **Subtitle:** "Shown in Codex's model picker, in this order." First use: "Pick the few models you switch between. 5 to 10 works well."
- **Tiles:** `repeat(auto-fill, minmax(140px,1fr))`, gap 8, at most 6 columns, square. Surface fill, 1px border, radius 12, padding 12.
  - Top left: glyph and number. Top right: ⋯ (fg-3 at rest).
  - Bottom: name (2 lines) and connection name. An unavailable model shows "! Unavailable".
  - One Add tile ("+ Add model"; "Drop to add" while dragging) switches to All models and focuses search.
- **Toolbar (32px):** search field ("Search models or connections") plus the segmented **All models | In picker** switch (a radio group).
- **Status line (20px):** "10 models" / "0 of 10 match "xyz" · Clear" / "4 in picker" / "Loading models…" / "! Couldn't update · Retry". Example counts.
- **All models view:** grouped under connection labels with glyphs. Rows are 36px with no separators. Trailing "+" or "✓ 3". "Unavailable until refresh" in warning colour. Same-family models on different connections stay as distinct rows.
- **In picker view:** the same order as a list, with a drag handle on hover/focus, glyph, name, "via X" and ⋯. This is the accessible reorder path.
- **⋯ menu (260px):** name; "via X"; reasoning block; Move earlier / Move later; Remove from picker (plain text, because removal is reversible). An unavailable model adds "Unavailable until its connection is refreshed." The exact model ID is not shown.
- **Glyphs (Home only, original artwork):** cloud (Codex), terminal `›_` (Claude Code), route (OpenRouter), outlined initial (custom endpoints and fallback). Inline SVG, `currentColor`, `aria-hidden`. No trademark artwork, no native picker icon, no emoji in names.
- **Reset:** not in the UI until BG4 limits it to native defaults.

### Reasoning lines (⋯ menu; advertised levels only)

| Case | Line 1 | Line 2 |
|---|---|---|
| GPT / Claude | Reasoning levels · <actual list> · default <default> | Levels are chosen per chat in Codex. |
| OpenRouter with listed levels | Reasoning levels · Low, Medium, High · default Medium | Levels are chosen per chat in Codex. |
| Dynamic router (`openrouter/free`, `/auto`) | Reasoning levels · none listed | OpenRouter can pick a different model for each request, so it lists no levels. If a level is chosen in Codex, it's passed to OpenRouter, which may ignore it. |
| OpenRouter without metadata | Reasoning levels · none listed | OpenRouter lists no levels for this model. If a level is chosen in Codex, it's passed to OpenRouter, which may ignore it. |
| Endpoint without metadata | Reasoning levels · none listed | This endpoint's model list doesn't include reasoning levels. If a level is chosen in Codex, it's passed to the endpoint, which may ignore it. |

- **Level names:** None, Minimal, Low, Medium, High, Extra high, Max, Ultra. None is never called Off or Automatic.
- **"Passed to…" sentence:** BG9 captured explicit Medium → `effort:medium` (synthetic, exact native 0.167). The picker's own behaviour is still unverified (HG2).
- **Native picker text (copy only, IDs unchanged):**
  - `displayName` `<model id> · <connection name>`
  - `description` "Runs through <connection name>. Tool support depends on the model."
  - level description "Listed by <connection name> for this model."

### Connections

- **Layout:** max width 720. Group labels 12 fg-2. Grouped lists use surface fill, 1px border, radius 12, 52px rows with separators inset 40px.
- **Row:** glyph, name over status, and on the right a chevron, one secondary button or a value plus chevron.
- **Connections view:** Connected rows open detail views. Connect more rows have one button each. Footer: "Codex sign-in, permissions and history stay in Codex." plus a collapsed Diagnostics disclosure.
- **Detail:** status line (✓ in success colour), then rows for Models · Refresh, Default for new chats, and Disconnect/Reconnect, then Technical details. Boundary lines:
  - Custom connection: "Chats started with <name> can switch between <name> models. To use another connection, start a new chat."
  - Claude Code: "A chat switched to Claude keeps its messages and tool results, but not earlier hidden reasoning."
- **Add endpoint form:** 32px fields with inline help. Errors start with "!". Cancel (ghost) and Connect (primary).

### Responsive and scrolling

- **≥960:** 6 tile columns, toolbar on one line.
- **600–959:** tiles `minmax(132px,1fr)`.
- **<600:** 12px padding; tiles `minmax(120px,1fr)`; search full width with the switch below as two equal segments; "Unsaved" hides visually first.
- **<360:** tiles `minmax(112px,1fr)`.
- **Never:** horizontal scrolling or overlap.
- **One scroll surface:** no inner `overflow:auto`, `max-height`, `overscroll-behavior` or `vh` heights. Removed from source: the library's inner scroll box, the fixed save bar and its 96px padding, fixed-position popovers.
- **Height reporting:** report `documentElement.scrollHeight` via size-changed only when documented `containerDimensions` gives no fixed height.
- **Bottom space:** `main { padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--bottom-clear)) }`, with the same value as `scroll-padding-bottom` on html. `--bottom-clear` is 32px, or 128px when `displayMode` is fullscreen or the height is fixed.
- **No other host field is read.** MCP Apps 2026-01-26 documents no `safeAreaInsets`. Reachability above the real composer is HG4.

## Chat refusals (final providerMessages; runtime copy e886, Root-accepted, 126 targeted checks pass; not installed; host rendering unverified HG1)

| Code | Text |
|---|---|
| `local_requires_new_thread` | This chat can't switch to that connection. No message was sent. Start a new chat to use it; this chat keeps its model and history. |
| `cross_provider_switch_requires_new_thread` | This chat can only use models from its own connection. No message was sent. Start a new chat to use another one; this chat keeps its model and history. |
| `model_not_available` | That model is no longer offered by this connection. No message was sent. Refresh the connection in Model Bridge, or choose another of its models. |
| `model_change_pending` | Another model change for this chat is still finishing. Try again in a moment. |
| `native_runtime_stale` | This chat's model was changed elsewhere, and this window can't safely switch to it. No message was sent and nothing was changed. To keep working now, start a new chat. |
| `native_selection_not_confirmed` | Couldn't confirm the model change, so this chat may still be on its previous model. No message was sent or retried. Choose the model again. |
| `native_permissions_changed` | This chat's permissions changed during the model switch. No message was sent. Check its permissions and model, then send again. |
| `model_change_requires_idle` | Wait for the current reply to finish, or stop it, before switching models. |
| `unsupported_reasoning_effort` | This model doesn't offer that reasoning level. No message was sent. Choose one of the levels listed for it. |
| `provider_disabled` | This chat's connection is disconnected. No message was sent. Reconnect it in Model Bridge › Connections. |
| `catalog_not_fresh` | This connection's model list needs a refresh. No message was sent. Refresh it in Model Bridge › Connections, then try again. |
| `free_model_required` | This connection allows free models only. No message was sent. Choose a free model. |
| `connection_changed` | This chat's connection was edited or removed, so it can't continue here. No message was sent. Its history stays readable; start a new chat to keep working. |
| `custom_provider_queue_not_qualified` | Messages can't be queued on this connection yet. Your message wasn't queued; send it after the current reply finishes. |
| other | Model Bridge stopped this request (`<code>`). |

**Continuity rules:**
- GPT↔GPT, Claude↔Claude, GPT↔Claude (visible handoff, same Codex thread ID) and same-custom-connection switches stay in the same chat.
- Any move to a different connection is refused before the endpoint is contacted. The person starts a new chat themselves.
- No fork UI, no hidden replacement chat, no custom↔Claude switching.

## Errors in Home (pattern unchanged)

One sentence, one action, then Details as plain text in the row (no nested box). Details say what was not affected.

| Code / situation | Message | Action |
| --- | --- | --- |
| `endpoint_invalid` | Use an https:// address, or http://127.0.0.1 with a port. | (fix field) |
| URL with credentials/query/fragment | Remove the password, token or query from the address. Choose a saved sign-in instead. | (fix field) |
| `provider_invalid` | Add a name and an address. | (fix field) |
| `provider_exists` | This address is already connected. | Show it |
| `credential_endpoint_mismatch` | This saved sign-in belongs to a different address. | Choose sign-in |
| `secret_storage_unavailable` | Can't save sign-ins on this Mac right now. | Try again |
| `catalog_unreachable` | Can't reach this endpoint. Last known models stay listed. | Refresh |
| `catalog_auth_required` | The endpoint refused the saved sign-in. | Choose sign-in |
| `catalog_rate_limited` | The endpoint is busy. Try again shortly. | Refresh |
| `catalog_protocol_unsupported` | This address didn't return a model list. | Edit address |
| `catalog_failed` | Couldn't load models. | Refresh |
| `auth_expired` / `auth_timeout` | Sign-in timed out. | Try again |
| `auth_cancelled` | Sign-in cancelled. | Connect |
| `auth_denied` | OpenRouter didn't approve the connection. | Try again |
| `auth_unreachable` / `auth_rate_limited` | Can't reach OpenRouter right now. / OpenRouter is limiting sign-ins. | Try again |
| `free_model_required` | Only free models can be chosen for this connection. | — |
| `stale_revision` | Changed in another window. | Reload |
| Status read failed | Couldn't update. | Retry (proposed: content stays visible and read-only) |
| Credential helper exit 90 | Couldn't read the saved OpenRouter sign-in. | Check again (**proposed, not implemented**) |
| Credential confirmed missing | OpenRouter sign-in is missing. | Reconnect (**proposed; needs a presence check that does not exist**) |

Exit 90 is never a reconnect prompt. Proposed helper text: "Model Bridge couldn't read the saved sign-in. Nothing was sent. Open Model Bridge › Connections to check."

## Interaction (retained rules)

- **Library:** lists every known native, Claude and endpoint model. Search matches model and connection names. Provider namespaces keep equal names distinct.
- **Hiding a model:** never deletes a chat, disables its connection or removes credentials.
- **Catalogs:** discovery implies no inference, and a catalog refresh is an explicit network action.
- **Connections:** connecting saves configuration. Disconnect is reversible, stops new admission, and keeps credentials, history and in-flight work. No destructive delete and no invented confirmation dialog.
- **Refreshes:** Home refreshes declared local state on open, every 10 s, and every 1 s during browser sign-in. Background reads never disable editing, rebuild unchanged controls, issue mutations or replay uncertain writes. Drafts survive refreshes.
- **Owner acceptance (9 Nov):** saved slots control the native picker; GPT model switching in the same chat works. Never restart an active chat, never spoof notifications, and add no restart prompt.
- **Host settings:** host-owned Settings/Plugins controls are not established by the public manifest docs, so Model Bridge uses its own Connections view.

## Board inventory (Paper, final)

Status values: **Impl** (in source; not native acceptance), **Prop** (proposed, not implemented), **Mixed** (behaviour exists, drawn form proposed), **Copy** (in runtime source e886, not installed; HG1 unverified).

| Page | Boards | Status |
| --- | --- | --- |
| Opus 00 · Index and direction | O0 index, tokens (dark/light), components | Prop |
| Opus 01 · Home | O1 wide dark/light · O2 compact dark/light · O3 loading · O4 first use · O4 no models · O5 couldn't update | Mixed / O3, O5 Prop |
| Opus 02 · In picker, library and menus | O6 ⋯ menu wide dark/light, compact unavailable · O7 In picker list view · O8 no matches · O9 drag · O10 keyboard + unsaved · O11 saved · O11 heading-row states | O6, O7 Prop; rest Mixed |
| Opus 03 · Connections | O12 dark/light · O13 OpenRouter, disconnected, Claude Code (light) · O14 add endpoint, validation · O15 catalog states | Mixed |
| Opus 04 · OpenRouter sign-in | O16–O20 · O21 exit 90, checking · O22 missing | O16–O20 Mixed; O21/O22 Prop, flagged NOT IMPLEMENTED |
| Opus 05 · Errors in chats | O23 × 3 refusals · O24 error pattern, helper message | O23 Copy; O24 Prop |
| Opus 06 · Reasoning and scrolling | O25 reasoning lines (6 cases) · O26 one scroll surface | Prop |

**Flows:**
- **Main:** O3 → O1 → search/O8 → + or O9 → O10 → Save → O11.
- **Edit:** O1 → O6 → Move/Remove → O10 → O11.
- **List view:** O1 → O7.
- **Gear:** O1 → O12 → O13/O14 → O15 → breadcrumb → O1.
- **OpenRouter:** O12 → O16 → O17 → O18, with branches O19 and O20.
- **Sign-in check (proposed):** O18 → O21 → O18 or O22 → O16.
- **Chat boundary:** existing chat → other connection → O23 → the person starts a new chat.
- **Reasoning:** O6 → O25.

## Paper composition status

- **Saved artwork revision:** `ba2cee1ad27ad8df14a4e3351f7ed5ca7118b1e2da13d6e96c49dcf5fc9b96a9`. The previous revision, `45c8e115…`, had four text boxes too narrow for real Inter widths. Two fixes, with no layers added or removed:
  - O0: the glyph legend is now a 2×2 grid with 220px labels.
  - Breadcrumbs: the current segment gets the remaining row width.
- **How it was made:** `work/opus-curation-compose.py` reads the previous paper.json with json/pathlib and writes only `work/opus-curation-staging.json`, committed through revisioned `paper_save`.
- **What changed:** Opus 00–05 were revised in place with the same page IDs; Opus 06 was added. That is 41 Opus artboards and 3,409 Opus layers.
- **What didn't:** the nine non-Opus pages are byte-identical, which the composer asserts.
- **Validation:** parent/child links, `next_id`, artboard bounds and caption height.
- **Readback:** 16 pages, 4,351 layers, matching staging.

**Not verified:**
- Native rendered appearance: actual text wrapping against the Inter width estimates, fallback for ✓ › ▾ → × ⋮⋮, and how legible the shape-built glyphs, gear and route arrows are.
- Desktop behaviour: HG1 (refusal rendering, draft kept), HG2 (picker behaviour for models with no listed levels), HG3 (displayName/description display), HG4 (reachable bottom above the actual composer).
- Backend: BG4 (reset limited to native defaults) and the read-only credential presence check that O21/O22 need.

## Earlier artwork (retained in the Paper as history)

The 7 November pages (Overview, Current, 01–36, Reference) and the earlier 9 November Opus light direction (Paper history `fffd12a0…`) are superseded. Their state coverage and source mapping stay useful: Entry 01–03, Models 04–08, Slot editing 09–13, Concurrent state 14–16, Connection management 17–21, OpenRouter 22–27, Catalog 28–30, Native picker 31–34, Access/diagnostics 35–36.

## Verification and remaining limits

- **Proof limits:** neither this specification nor the artwork proves interactive behaviour, live auth, endpoint inference, native model-menu geometry or native hot refresh.
- **Installed app:** 4215f2a is untouched. Runtime 6ee and copy e886 are accepted but not installed.
- **Rules for design work:** don't restart the test app or change the owner's chats.
- **Issues:** keep #24 and #19 open until native acceptance. #9, #10 and #15 have separate acceptance.

## Private integration readback - 7 November

The isolated test app served Home v9 on private runtime `preview.7413b8f`, source `7413b8f`:
- Native plugin/read and MCP discovery passed.
- Installation preserved the same binding, the normal profile and 15 history/auth records.
- The desktop model/list call returned 44 rows: 40 hidden and four selected (slots revision 2).
- The selected free OpenRouter route completed a native no-tool turn, history read, file-tool use, resume, fork and interruption on synthetic data.

These results do not override later desktop findings.

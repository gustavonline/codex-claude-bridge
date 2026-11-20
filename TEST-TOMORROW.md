# Bridge private Home candidate — 8 November 2026

Open **Model Bridge Test.app** at `/Users/gustavanderson/Applications/Model Bridge Test.app`, then the existing **Codex Bridge / Model Bridge Home** global entrypoint. Use the same isolated profile and plugin ID `codex-claude@bridge-dashboard-89a15ce`. The normal Codex profile is not activated by this candidate.

Source: branch `feature/home-connections-unified-20261107`, Home resource `ui://codex-claude/home-v9.html`. Installed in the existing isolated test app as private version `preview.7413b8f`, source `7413b8f9da54f5e1d4cfd8364debb467ff19f038`; native plugin/read, MCP discovery and serving Home v9 passed. The installation receipt verifies unchanged binding, normal config and 15 history/auth records. This is not a release build: manifests/pins in the source remain RC13 and package/distribution qualification is held.

## What changed

- Chosen square slots above one searchable model library. Connection and availability/slot filters combine; gear opens settings.
- One slot menu; full identity under Advanced; Save appears when needed and stays visible while pending. Reset/clear share Slot options.
- Home refreshes local state automatically; no mandatory Read current state button. It preserves drafts, checks concurrent revisions and recovers an uncertain save without repeating it.
- Saved OpenRouter sign-in remains connected after Home/backend reopen; duplicate browser login is refused. Endpoint and catalog errors remain actionable after status recovery.
- The local diagnostic log records bounded actual native `model/list` flags/counts/IDs for picker diagnosis, excluding raw RPC bodies, credentials, URLs, config and chat content.

## Meaningful checks tomorrow

1. Home should show the four saved choices: GPT6.1Sol, Opus5.5, Z13 qwen3.5:4b and OpenRouter openrouter/free. Search and filter without saving anything; return from settings and confirm the search draft survives.
2. Change one slot, observe Unsaved / Saving / Saved, and reopen Home. Its saved selection must persist. Restore your chosen four if you changed them.
3. Open settings: OpenRouter should say Connected, and should not offer a duplicate Connect login. Refreshing its catalog is explicit; discovering a catalog does not prove inference.
4. Inspect the actual native model picker. After the controlled idle restart, the real desktop requested `model/list` with `includeHidden:true`, limit 100 and no cursor, receiving 44 rows: 40 hidden and four selected at slots revision 2. This respects the documented contract; a hidden-inclusive list is not proof of four-only visible choices. `includeHidden:false` returned the four visible choices in a separate real protocol check. Native visual confirmation remains pending. Home cannot force invalidation through a documented API; no fake notification or active-turn restart is implemented.
5. The selected OpenRouter free route has already completed a real native read-only/no-tool turn: correct synthetic answer in 4,951ms and new-history read passed. You can try a useful conversation in the same test app. No paid fallback, new key or funding is allowed. A distinct follow-up also passed actual file-tool use on a synthetic file, resume, new-history read and fork in 17.414s, with supported unsubscribe cleanup. Two further native cancellation checks passed: before output (49ms) and after the first text delta (2,655ms), both with interrupted terminal state/history read and supported cleanup. Visible GUI qualification remains separate.

## Design

OpenPaperDesign → this project → **Model Bridge — Home and connections**, ID `d3ace862e4f02e85`. Eight pages contain an overview, 36 numbered flow/state artboards and three preserved references (40 artboards total). [design.md](design.md) maps every flow to source/planned/external status and #24/#19. Native Apply/restart and post-restart verification are planned operator handoffs, not working Home controls.

## Verified and still open

The focused Node checks currently pass (83/83 across seven explicitly named safe files; the latest small UI follow-up also passes). Actual shipped Home JS/CSS was exercised through a synthetic public MCP Apps browser host at 1100px and 390px: search/filter, slot edit/save/pending/confirmation, settings, durable Connected display and full-name disclosure passed. Compact slot measurements were 152.39 × 152.39px, body scrollWidth equalled 390px. The fixture contacted no account, endpoint or model. Native Paper/app visual inspection is unavailable through the exposed computer tools and is not claimed passed.

#24 is improved but remains open for actual native picker consumption and full runtime acceptance. #19 remains open for primary-app adoption and its functional evidence. #9/#10/#15 are separate unresolved outcomes; none is closed merely because this candidate exists. Earlier real Z13/Qwen and OpenRouter PKCE/catalog proofs are retained at their original scope.

No full/glob/package/distribution suites, held connections test, FIFO operation, normal-profile install, push, merge or release were performed. No owner credentials/history were copied. Initial test failures (missing local dependencies, noncanonical default Mac temp path and obsolete UI assertions) are retained in the task work logs; pinned dependencies were installed offline with scripts disabled and tests ran in a private canonical task directory.

Operator evidence, read back for this guide: the installed source is 7413b8f; native discovery, actual desktop catalog logs and QUALIFIED-RESULT from openrouter-native-03 are retained under the isolated runtime evidence directory. The raw probe retains an obsolete thread/unload cleanup request after its successful turn/history read; thread/unsubscribe is the supported native request. A first inference attempt with an artificial blank HOME failed before inference because it could not reach the Keychain. The same fixed helper worked under the actual OS HOME, with blank task CODEX_HOME/no auth copy. No key was printed or transferred.

Further actual native proof: openrouter-native-tool/RESULT.json passed one free file-tool turn in the same synthetic test thread, resumed through a new Bridge/native provider child. The model read qualification.json and returned the expected sum41 and labelbridge-public-fixture; duration17.414s. Native history read and fork with retained parent/model and a new ID passed. Both thread/unsubscribe cleanup calls and process exit0 passed. The first unquoted space-containing path failed; the model recovered with a quoted read, and both commands remain in the synthetic evidence. No owner history/auth copy or paid fallback was used. Native early and first-delta cancellation subsequently passed; do not repeat these successful probes merely as a baseline.

Final operator checkpoint: distinct openrouter-native-cancel and openrouter-native-stream-cancel results passed. The latter observed a first text delta, accepted native interrupt, reached interrupted terminal state in2655ms and passed new-history read, thread/unsubscribe cleanup and child exit0. The separate early-cancel case took49ms. Both stayed on the free/no-tool synthetic route. The same isolated test app is running idle; no further model call is needed for this checkpoint. Remaining unavailable acceptance is visible native picker/full GUI behavior, native Paper rendering, normal-profile adoption and package/release qualification.

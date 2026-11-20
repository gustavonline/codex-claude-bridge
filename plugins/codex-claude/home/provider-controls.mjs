// Public MCP Apps controller for a declared isolated Bridge/profile. Operator
// startup supplies the one manifest; tool arguments cannot choose a file/root,
// credential path, helper executable, protocol translator or model runtime.
import { claudeDecision, readConnections, setEnabled } from './connection-policy.mjs';
import { BrowserAuth, openRouterBase } from './browser-auth.mjs';
import { randomBytes } from 'node:crypto';
import { mkdirSync, lstatSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { ProviderRegistry, rootOk, readPrivate, localModelId, freeOnly, modelReasoning } from './providers.mjs';
import { harnessStatuses, readHarnessSettings, setHarnessEnabled } from './harnesses.mjs';
const identity = p => { const s = lstatSync(p); return [s.dev, s.ino, s.uid, s.mode & 0o777].join(':'); };
const fail = code => { throw Object.assign(new Error(code), { code }); };
const id = x => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x);
const exact = (x, fields) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join() === [...fields].sort().join();
export function prepareProviderHome(root, { credentialBindings = null } = {}) {
  if (!isAbsolute(root)) fail('binding_invalid');
  if (credentialBindings !== null && !isAbsolute(credentialBindings)) fail('binding_invalid');
  const scope = { bindingId: randomBytes(16).toString('hex'), profileId: randomBytes(16).toString('hex'), bridgeId: randomBytes(16).toString('hex') };
  mkdirSync(root, { mode: 0o700 }); rootOk(root);
  for (const name of ['profile', 'state']) mkdirSync(join(root, name), { mode: 0o700 });
  const value = { version: 1, kind: 'bridge-provider-trial', ...scope, root: identity(root), profile: identity(join(root, 'profile')), state: identity(join(root, 'state')), credentialBindings };
  writeFileSync(join(root, 'profile/provider-home.json'), JSON.stringify(scope) + '\n', { flag: 'wx', mode: 0o600 });
  const path = join(root, 'provider-home-binding.json'); writeFileSync(path, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  return { bindingPath: path, state: join(root, 'state'), scope };
}
export function providerControls(path, { request, secrets, authOptions = {} } = {}) {
  if (!isAbsolute(path) || basename(path) !== 'provider-home-binding.json') fail('binding_invalid');
  const root = dirname(path); rootOk(root); const m = readPrivate(path, 8192), original = JSON.stringify(m);
  const fields = ['version', 'kind', 'bindingId', 'profileId', 'bridgeId', 'root', 'profile', 'state', 'credentialBindings'];
  if (!exact(m, fields) || m.version !== 1 || m.kind !== 'bridge-provider-trial' || !id(m.bindingId) || !id(m.profileId) || !id(m.bridgeId)
    || !(m.credentialBindings === null || typeof m.credentialBindings === 'string' && isAbsolute(m.credentialBindings))) fail('binding_invalid');
  const scope = { bindingId: m.bindingId, profileId: m.profileId, bridgeId: m.bridgeId }, state = join(root, 'state');
  const registry = new ProviderRegistry(state, m.credentialBindings, { secrets });
  const guard = () => {
    for (const [p, expected] of [[root, m.root], [join(root, 'profile'), m.profile], [state, m.state]]) { rootOk(p); if (identity(p) !== expected) fail('binding_invalid'); }
    if (JSON.stringify(readPrivate(path, 8192)) !== original || JSON.stringify(readPrivate(join(root, 'profile/provider-home.json'), 512)) !== JSON.stringify(scope)) fail('binding_invalid');
  };
  let authRevision = null;
  const auth = new BrowserAuth({ ...authOptions, secrets: registry.broker.secrets, guard,
    onAuthorized: reference => {
      guard(); if (snapshot().revision !== authRevision) fail('stale_revision');
      return registry.create({ name: 'OpenRouter', baseUrl: openRouterBase, authRef: reference, freeOnly: true });
    } });
  const snapshot = (focusedProvider = null) => {
    guard(); const all = registry.all(), slots = registry.slots(), catalog = registry.pickerCatalog(), claude = claudeDecision(state), claudeStore = readConnections(state), refresh = registry.pickerRefresh(), reserved = new Set(registry.reservedPickerModels());
    const revision = all.reduce((n, p) => n + p.revision + 1, slots.revision + catalog.revision + refresh.revision + readHarnessSettings(state).revision + (claudeStore.status === 'ok' ? claudeStore.store.revision : 0));
    if (!Number.isSafeInteger(revision)) fail('revision_exhausted');
    return { kind: 'responses-trial', ...scope, revision, focusedProvider, slots: { revision: slots.revision, models: slots.models, scope: slots.version === 2 ? 'all' : 'custom', catalogRevision: catalog.revision },
      pickerRefresh: { requested: refresh.revision, observed: catalog.requestRevision ?? 0, kind: refresh.kind }, auth: auth.status(), authReferences: registry.broker.references(), harnesses: harnessStatuses({ root: state }), providers: [...['native', 'claude'].map((kind, i) => ({ id: (i + 1).toString(16).padStart(32, '0'), kind,
        name: kind === 'native' ? 'Codex / GPT' : 'Claude Code', baseUrl: '', protocol: kind, authRef: null, selected: null,
        enabled: kind === 'native' || claude.policy.enabled,
        catalogState: catalog.nativeFailed === true ? 'stale' : !catalog.revision ? 'unknown' : catalog.models.some(m => m.kind === kind && !m.available) ? 'stale' : 'fresh',
        models: catalog.models.filter(m => m.kind === kind).map(m => ({ ...m, available: m.available && (kind === 'native' || claude.policy.enabled) })) })), ...all.map(s => ({ id: s.connectionId, name: s.name, baseUrl: s.baseUrl,
        protocol: s.protocol, authRef: s.authRef, freeOnly: freeOnly(s), catalogError: s.catalog?.error ?? null, enabled: s.enabled, selected: s.selected, catalogState: s.catalog?.status ?? 'unknown',
        models: (s.catalog?.models ?? []).map(model => ({ id: localModelId(s.connectionId, model), name: model, capabilities: modelReasoning(s, model), available: !reserved.has(localModelId(s.connectionId, model)) && (!freeOnly(s) || s.catalog?.details?.some(m => m.id === model && m.free === true)) })) }))] };
  };
  snapshot();
  const properties = { providerId: { type: 'string', pattern: '^[a-f0-9]{32}$' }, revision: { type: 'integer', minimum: 0 } };
  const str = maxLength => ({ type: 'string', maxLength });
  return {
    prefix: 'bridge_provider_', message: 'Provider controls apply only to the declared isolated Bridge. Catalog observations do not verify inference, native picker availability or ordinary-launch activation.',
    definitions: [
      ['status', {}, 'Read this declared provider registry.'],
      ['auth_begin', { revision: properties.revision }, 'Begin human OpenRouter browser PKCE sign-in; no code/verifier/key is returned.', true],
      ['auth_cancel', { revision: properties.revision }, 'Cancel this pending browser authorization; never delete existing credentials.'],
      ['connect', { revision: properties.revision, name: str(80), baseUrl: str(2048), authRef: { anyOf: [{ type: 'null' }, str(64)] } }, 'Save an explicit Responses provider; no model call or credential import.'],
      ['refresh', properties, 'Request this provider catalog; credentials, if selected, stay in its URL-bound native broker.', true],
      ['select', { ...properties, model: str(800) }, 'Choose a discovered model for new explicitly routed threads.'],
      ['enabled', { ...properties, enabled: { type: 'boolean' } }, 'Enable/disable new Bridge admission; retained history is not deleted.'],
      ['harness', { revision: properties.revision, harness: { type: 'string', enum: ['antigravity'] }, enabled: { type: 'boolean' } }, 'Enable or disable a harness for new chats where its boundary is supported; it uses its own sign-in, and nothing is installed or signed in here.'],
      ['slots', { revision: properties.revision, slotsRevision: properties.revision,
        catalogRevision: properties.revision, reset: { type: 'boolean' },
        models: { type: 'array', items: str(800), maxItems: 4096, uniqueItems: true } }, 'Save model picker visibility across all connections. Hiding is not disabling or deleting credentials/history.'],
    ],
    snapshot, close: () => auth.close(),
    async call(action, args) {
      const extra = { status: [], harness: ['revision', 'harness', 'enabled'], auth_begin: ['revision'], auth_cancel: ['revision'], connect: ['revision', 'name', 'baseUrl', 'authRef'], refresh: ['revision', 'providerId'], select: ['revision', 'providerId', 'model'], enabled: ['revision', 'providerId', 'enabled'], slots: ['revision', 'slotsRevision', 'models'] }[action];
      const unified = action === 'slots' && Object.hasOwn(args, 'catalogRevision');
      if (unified) extra.push('catalogRevision', ...(Object.hasOwn(args, 'reset') ? ['reset'] : []));
      if (!extra || !exact(args, [...Object.keys(scope), ...extra])) fail('invalid_request');
      if (Object.keys(scope).some(k => args[k] !== scope[k])) fail('wrong_scope');
      const before = snapshot();
      if (action === 'status') return before;
      if (args.revision !== before.revision) fail('stale_revision');
      let focus = args.providerId;
      if (action === 'auth_begin') {
        if (before.providers.some(p => p.baseUrl === openRouterBase && p.authRef && before.authReferences.some(r => r.id === p.authRef && r.baseUrl === p.baseUrl))) fail('provider_exists');
        if (!auth.attempt) authRevision = before.revision; await auth.begin(); guard(); return snapshot();
      }
      if (action === 'auth_cancel') { auth.cancel(); return snapshot(); }
      if (action === 'harness') { setHarnessEnabled(state, args.harness, args.enabled); guard(); return snapshot(); }
      if (action === 'connect') focus = registry.create({ name: args.name, baseUrl: args.baseUrl, authRef: args.authRef });
      else if (action === 'refresh') {
        if (['00000000000000000000000000000001', '00000000000000000000000000000002'].includes(focus)) registry.requestPickerRefresh(focus.endsWith('1') ? 'native' : 'claude', before.pickerRefresh.requested);
        else await registry.refresh(focus, request ? { request } : {});
      }
      else if (action === 'select') registry.select(focus, args.model);
      else if (action === 'slots') {
        if (!unified) registry.saveSlots(args.models, args.slotsRevision);
        else if (args.reset === true) { if (!Array.isArray(args.models) || args.models.length) fail('invalid_request'); registry.resetPickerSlots(args.slotsRevision, args.catalogRevision); }
        else { if (args.reset !== undefined && args.reset !== false) fail('invalid_request'); registry.savePickerSlots(args.models, args.slotsRevision, args.catalogRevision); }
      } else if (focus === '00000000000000000000000000000002') {
        const current = readConnections(state);
        if (current.status !== 'ok' && current.status !== 'absent') fail('store_unavailable');
        setEnabled(state, args.enabled, { create: current.status === 'absent', expectedRevision: current.status === 'ok' ? current.store.revision : undefined, wait: false });
      } else { if (focus === '00000000000000000000000000000001') fail('native_account_managed_by_codex'); registry.enabled(focus, args.enabled); }
      guard(); return snapshot(focus);
    },
  };
}

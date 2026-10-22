import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The CI event guard and required aggregate (issue #15). Reads the actual
// workflow and runs its own select and aggregate scripts with synthetic events
// and job results. No package, bundle, install, artifact or upload command runs.
const workflow = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8').split('\n');
const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const scratch = mkdtempSync(join(process.env.BRIDGE_CI_SCRATCH ?? tmpdir(), 'bridge-ci-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Just enough YAML for this two-space workflow: a key's block, scalars and steps.
const indent = line => line.length - line.trimStart().length;
function section(lines, key, depth) {
  const start = lines.findIndex(line => indent(line) === depth && line.trimStart().startsWith(`${key}:`));
  assert.ok(start >= 0, `${key} is defined`);
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || indent(lines[end]) > depth || (indent(lines[end]) === depth && lines[end].trimStart().startsWith('#')))) end++;
  return lines.slice(start, end);
}
function scalar(lines, key, depth) {
  const line = lines.find(line => indent(line) === depth && line.trimStart().startsWith(`${key}:`));
  return line === undefined ? null : line.trimStart().slice(key.length + 1).trim();
}
const jobs = section(workflow, 'jobs', 0);
const jobIds = jobs.filter(line => indent(line) === 2 && /^\s*[\w-]+:\s*$/.test(line)).map(line => line.trim().slice(0, -1));
const job = id => section(jobs, id, 2);
function steps(id) {
  const items = [];
  for (const line of section(job(id), 'steps', 4).slice(1)) {
    if (indent(line) === 6 && line.trimStart().startsWith('- ')) items.push([' '.repeat(8) + line.trimStart().slice(2)]);
    else if (items.length) items.at(-1).push(line);
  }
  return items.map(lines => {
    let run = scalar(lines, 'run', 8);
    if (run === '|') run = section(lines, 'run', 8).slice(1).filter(line => line.trim()).map(line => line.slice(10)).join('\n');
    const env = lines.some(line => indent(line) === 8 && line.trim() === 'env:') ? Object.fromEntries(section(lines, 'env', 8).slice(1).filter(line => line.trim())
      .map(line => { const match = /^\s*([A-Z_]+): (.+)$/.exec(line); assert.ok(match, line); return [match[1], match[2]]; })) : {};
    return { name: scalar(lines, 'name', 8), id: scalar(lines, 'id', 8), uses: scalar(lines, 'uses', 8), run, env };
  });
}

// The two expression forms this workflow uses; anything else fails the test.
function resolve(expression, context) {
  const match = /^\$\{\{\s*([\w.-]+)\s*\}\}$/.exec(expression);
  assert.ok(match, `supported expression: ${expression}`);
  const value = match[1].split('.').reduce((object, part) => object?.[part], context);
  return value == null ? '' : String(value);
}
function condition(expression, context) {
  if (expression === 'always()') return true;
  const match = /^([\w.-]+) == '([^']*)'$/.exec(expression);
  assert.ok(match, `supported condition: ${expression}`);
  return resolve(`\${{ ${match[1]} }}`, context) === match[2];
}

// Run a step's actual script as the runner does (bash -e), with its env resolved.
let count = 0;
function run(step, context) {
  const output = join(scratch, `output-${++count}`), script = join(scratch, `step-${count}.sh`);
  writeFileSync(output, ''); writeFileSync(script, `${step.run}\n`);
  const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, resolve(value, context)])) };
  const result = spawnSync('bash', ['-e', script], { env, encoding: 'utf8' });
  const raw = readFileSync(output, 'utf8');
  const outputs = Object.fromEntries(raw.split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  return { status: result.status, raw, outputs, stderr: result.stderr, stdout: result.stdout };
}
const aggregate = needs => run(steps('checks')[0], { needs });

// One workflow run: select, then whether the package job starts, then the aggregate.
// github is the synthetic event context (event_name alone when only event is given);
// select stands for that job's own outcome; full and source are the other jobs' results.
function simulate({ event, github = { event_name: event }, qualification, select = 'success', full = 'success', source = 'success' }) {
  const context = { github, inputs: qualification === undefined ? {} : { qualification } };
  const needs = { select: { result: select, outputs: {} }, source: { result: source } };
  if (select === 'success') {
    const ran = run(steps('select').find(step => step.id === 'select'), context);
    assert.equal(ran.status, 0, ran.stderr);
    needs.select.outputs.full = resolve(scalar(section(job('select'), 'outputs', 4), 'full', 6), { steps: { select: { outputs: ran.outputs } } });
  }
  // Without a status function, a job runs only when its needs succeeded and its condition holds.
  const started = needs.select.result === 'success' && condition(scalar(job('test'), 'if', 4), { needs });
  needs.test = { result: started ? full : 'skipped' };
  assert.equal(condition(scalar(job('checks'), 'if', 4), { needs }), true, 'the aggregate always runs');
  return { started, selected: needs.select.outputs.full, aggregate: aggregate(needs) };
}

const PACKAGE = /\bnpm (?:ci|run|pack|publish)\b|bundle|test:distribution|check-artifacts|gh release|upload-artifact/;

test('only the guarded package job can build, scan or upload artifacts, and its full path is unchanged', () => {
  assert.deepEqual(jobIds, ['select', 'source', 'test', 'checks']);
  for (const id of ['select', 'source', 'checks']) {
    for (const step of steps(id)) assert.ok(!PACKAGE.test(`${step.run ?? ''} ${step.uses ?? ''}`), `${id}: ${step.name ?? step.uses ?? step.run}`);
  }
  // The source path runs only the changed CI proof.
  assert.deepEqual(steps('source').filter(step => step.run).map(step => step.run), ['node --test test/ci.test.mjs']);
  // No smaller job takes the required context name.
  for (const id of ['select', 'source', 'test']) assert.notEqual(scalar(job(id), 'name', 4), 'checks');
  // The full path keeps its package and final-artifact steps, in order, behind the selection.
  assert.equal(scalar(job('test'), 'needs', 4), 'select');
  assert.equal(scalar(job('test'), 'if', 4), "needs.select.outputs.full == 'true'");
  assert.deepEqual(steps('test').filter(step => step.run).map(step => step.run), ['npm ci --ignore-scripts --omit=optional --no-audit --no-fund', 'npm run check',
    'npm run bundle -- --check', 'npm run test:distribution', 'node scripts/check-artifacts.mjs', 'node scripts/check-artifacts.mjs --verify']);
  // The aggregate depends on every job and always runs, so it is never skipped into a pass.
  assert.equal(scalar(job('checks'), 'if', 4), 'always()');
  assert.deepEqual(scalar(job('checks'), 'needs', 4).replace(/^\[|\]$/g, '').split(',').map(id => id.trim()).sort(), ['select', 'source', 'test']);
  // Events: ordinary push; pull requests with the default activities plus labeled; a manual run whose default is source-only.
  const on = section(workflow, 'on', 0);
  assert.deepEqual(on.filter(line => indent(line) === 2).map(line => line.trim()), ['push:', 'pull_request:', 'workflow_dispatch:']);
  assert.equal(scalar(section(on, 'pull_request', 2), 'types', 4), '[opened, synchronize, reopened, labeled]');
  const input = section(on, 'workflow_dispatch', 2);
  assert.equal(scalar(input, 'default', 8), 'source-only');
  assert.equal(scalar(input, 'options', 8), '[source-only, full-artifacts]');
  // A read-only token for every job: only the top-level grant, no job override.
  assert.deepEqual(section(workflow, 'permissions', 0).slice(1).map(line => line.trim()), ['contents: read']);
  for (const id of jobIds) assert.equal(scalar(job(id), 'permissions', 4), null, `${id}: no permission override`);
  // The selector reads only GitHub-set event fields and IDs, never pull-request text.
  assert.deepEqual(steps('select').find(step => step.id === 'select').env, {
    EVENT: '${{ github.event_name }}', ACTION: '${{ github.event.action }}', LABEL: '${{ github.event.label.name }}',
    SENDER_ID: '${{ github.event.sender.id }}', OWNER_ID: '${{ github.repository_owner_id }}', REPOSITORY_ID: '${{ github.repository_id }}',
    HEAD_REPOSITORY_ID: '${{ github.event.pull_request.head.repo.id }}', BASE_REPOSITORY_ID: '${{ github.event.pull_request.base.repo.id }}',
    REQUESTED: '${{ inputs.qualification }}',
  });
  // The accepted draft-release gate stays tag-only and checks the exact artifacts before upload.
  assert.match(release, /on:\n {2}push:\n {4}tags: \['v\*'\]\n/);
  const scan = release.indexOf('run: node scripts/check-artifacts.mjs\n'), gate = release.indexOf('node scripts/check-artifacts.mjs --verify >'), upload = release.indexOf('gh release create');
  assert.ok(scan > 0 && scan < gate && gate < upload, 'scan, then verify, then the draft upload');
});

test('ordinary pushes, pull requests and default or other manual runs never start the package job, and the required aggregate fails', () => {
  for (const [event, qualification] of [
    ['push', undefined], ['pull_request', undefined], // A draft pull request is the same event; draft state is not an input.
    ['push', 'full-artifacts'], ['pull_request', 'full-artifacts'], // An input cannot select the package path from another event.
    ['workflow_dispatch', 'source-only'], ['workflow_dispatch', undefined], ['workflow_dispatch', ''],
    ['workflow_dispatch', 'FULL-ARTIFACTS'], ['workflow_dispatch', 'full-artifacts '], ['workflow_dispatch', 'true'], ['workflow_dispatch', 'full'],
    ['workflow_run', 'full-artifacts'], ['schedule', undefined],
  ]) {
    const name = `${event} ${JSON.stringify(qualification)}`;
    const result = simulate({ event, qualification });
    assert.equal(result.selected, 'false', name);
    assert.equal(result.started, false, `${name}: the package job is skipped`);
    assert.notEqual(result.aggregate.status, 0, `${name}: a source-only pass leaves required checks failing`);
    assert.match(result.aggregate.stdout, /Required checks unsatisfied/, name);
  }
});

test('a failed, cancelled, skipped or missing result anywhere leaves the required aggregate failing', () => {
  const full = { event: 'workflow_dispatch', qualification: 'full-artifacts' };
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    assert.notEqual(simulate({ ...full, full: result }).aggregate.status, 0, `package job ${JSON.stringify(result)}`);
    assert.notEqual(simulate({ ...full, source: result }).aggregate.status, 0, `source job ${JSON.stringify(result)}`);
  }
  for (const select of ['failure', 'cancelled']) {
    const result = simulate({ ...full, select });
    assert.equal(result.started, false, `select ${select}: the package job does not start`);
    assert.notEqual(result.aggregate.status, 0, `select ${select}`);
  }
  // Direct inputs: a passing package result without a recorded selection is not enough.
  const passed = { result: 'success' };
  for (const needs of [{ select: { result: 'success', outputs: {} }, source: passed, test: passed },
    { select: { result: 'success', outputs: { full: 'false' } }, source: passed, test: passed },
    { select: { result: 'failure', outputs: { full: 'true' } }, source: passed, test: passed }, {}]) {
    assert.notEqual(aggregate(needs).status, 0, JSON.stringify(needs));
  }
});

test('an explicit manual full-artifacts run starts the package job, and only its success satisfies the aggregate', () => {
  const result = simulate({ event: 'workflow_dispatch', qualification: 'full-artifacts' });
  assert.equal(result.selected, 'true');
  assert.equal(result.started, true);
  assert.equal(result.aggregate.status, 0, result.aggregate.stdout + result.aggregate.stderr);
});

// A synthetic pull_request labeled event as GitHub would send it: the owner (ID 7001)
// newly adds the exact label to a pull request whose head and base are this repository (ID 9001).
const LABEL = 'full-artifact-qualification';
function labeled(change = () => {}) {
  const github = {
    event_name: 'pull_request', repository_id: '9001', repository_owner_id: '7001', repository_owner: 'synthetic-owner',
    event: { action: 'labeled', label: { name: LABEL }, sender: { id: 7001, login: 'synthetic-owner' },
      pull_request: { title: 'Synthetic', body: '', labels: [{ name: LABEL }], head: { repo: { id: 9001 } }, base: { repo: { id: 9001 } } } },
  };
  change(github);
  return github;
}

test('the repository owner newly adding the exact label to a same-repository pull request selects the package path', () => {
  const result = simulate({ github: labeled() });
  assert.equal(result.selected, 'true');
  assert.equal(result.started, true);
  assert.equal(result.aggregate.status, 0, result.aggregate.stdout + result.aggregate.stderr);
  // Only full success satisfies the aggregate on this route too.
  for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
    assert.notEqual(simulate({ github: labeled(), full: outcome }).aggregate.status, 0, `package job ${JSON.stringify(outcome)}`);
    assert.notEqual(simulate({ github: labeled(), source: outcome }).aggregate.status, 0, `source job ${JSON.stringify(outcome)}`);
  }
  for (const select of ['failure', 'cancelled']) {
    const failed = simulate({ github: labeled(), select });
    assert.equal(failed.started, false, `select ${select}`);
    assert.notEqual(failed.aggregate.status, 0, `select ${select}`);
  }
});

test('ordinary, wrong or untrusted pull-request activity stays source-only, even with the label present', () => {
  const pr = github => github.event.pull_request;
  for (const [name, change, qualification] of [
    // Activity: only a newly added label counts; the label persisting on the pull request does not.
    ['synchronize (new head) with the label kept', github => { github.event.action = 'synchronize'; delete github.event.label; }],
    ['synchronize with a label in the payload', github => { github.event.action = 'synchronize'; }],
    ['opened with the label', github => { github.event.action = 'opened'; delete github.event.label; }],
    ['reopened with the label', github => { github.event.action = 'reopened'; delete github.event.label; }],
    ['unlabeled', github => { github.event.action = 'unlabeled'; }],
    ['edited', github => { github.event.action = 'edited'; }],
    ['no action', github => { delete github.event.action; }],
    // Label: the event's added label, exactly.
    ['another label added', github => { github.event.label.name = 'bug'; }],
    ['a differently cased label', github => { github.event.label.name = 'Full-Artifact-Qualification'; }],
    ['a label with a trailing space', github => { github.event.label.name = `${LABEL} `; }],
    ['no added label, only the persisted list', github => { delete github.event.label; }],
    // Sender: the repository owner, by ID.
    ['another sender', github => { github.event.sender = { id: 7002, login: 'someone-else' }; }],
    ['the owner login with another ID', github => { github.event.sender = { id: 7002, login: 'synthetic-owner' }; }],
    ['no sender', github => { delete github.event.sender; }],
    ['no owner ID and no sender', github => { github.repository_owner_id = ''; delete github.event.sender; }],
    // Repositories: head and base are this repository.
    ['a fork head', github => { pr(github).head.repo.id = 9002; }],
    ['a deleted fork head', github => { pr(github).head = {}; }],
    ['a foreign base', github => { pr(github).base.repo.id = 9002; }],
    ['no repository IDs', github => { github.repository_id = ''; pr(github).head = {}; pr(github).base = {}; }],
    // Event: only pull_request.
    ['pull_request_target', github => { github.event_name = 'pull_request_target'; }],
    ['a push carrying a pull-request payload', github => { github.event_name = 'push'; }],
    ['a default manual run carrying a label payload', github => { github.event_name = 'workflow_dispatch'; }],
    // Pull-request text and inputs cannot stand in for the event.
    ['text and an input claiming qualification', github => { github.event.action = 'synchronize'; delete github.event.label;
      pr(github).title = LABEL; pr(github).body = `labeled ${LABEL} by synthetic-owner`; }, 'full-artifacts'],
  ]) {
    const result = simulate({ github: labeled(change), qualification });
    assert.equal(result.selected, 'false', name);
    assert.equal(result.started, false, `${name}: the package job is skipped`);
    assert.notEqual(result.aggregate.status, 0, `${name}: required checks stay failing`);
  }
  // A later head needs a fresh owner action: the qualified label stays, the next push is source-only.
  assert.equal(simulate({ github: labeled() }).selected, 'true');
  assert.equal(simulate({ github: labeled(github => { github.event.action = 'synchronize'; delete github.event.label; }) }).selected, 'false');
});

test('hostile event values cannot inject an output, quote or command into the selector or aggregate', () => {
  const marker = join(scratch, 'injected');
  const select = steps('select').find(step => step.id === 'select');
  for (const value of [`x"\nfull=true`, 'x\nfull=true', `$(touch ${marker})`, `\`touch ${marker}\``, "'; full=true; '",
    `${LABEL}" ] && [ "x" = "x`, `${LABEL}\nfull=true`]) {
    for (const [field, change, qualification] of [
      ['label', github => { github.event.label.name = value; }],
      ['action', github => { github.event.action = value; }],
      ['sender', github => { github.event.sender.id = value; }],
      ['head repository', github => { github.event.pull_request.head.repo.id = value; }],
      ['title', github => { github.event.action = 'synchronize'; github.event.pull_request.title = value; }],
      ['manual input', github => { github.event_name = 'workflow_dispatch'; }, value],
    ]) {
      const ran = run(select, { github: labeled(change), inputs: qualification === undefined ? {} : { qualification } });
      assert.equal(ran.status, 0, `${field} ${JSON.stringify(value)}: ${ran.stderr}`);
      assert.equal(ran.raw, 'full=false\n', `${field} ${JSON.stringify(value)}: exactly one false output`);
      assert.equal(existsSync(marker), false, `${field} ${JSON.stringify(value)}: nothing executed`);
    }
    const passed = { result: 'success' };
    const refused = aggregate({ select: { result: 'success', outputs: { full: value } }, source: passed, test: passed });
    assert.notEqual(refused.status, 0, `aggregate ${JSON.stringify(value)}`);
    assert.equal(existsSync(marker), false, `aggregate ${JSON.stringify(value)}: nothing executed`);
  }
});

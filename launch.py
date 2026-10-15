#!/usr/bin/env python3
"""Launch the installed, unmodified Codex app with an isolated runtime/profile."""
import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import stat
import subprocess
import tomllib
import sys
import time

ROOT = Path(__file__).resolve().parent
DEFAULT_STATE = Path.home() / 'Library/Application Support/Codex Claude Bridge'


def running_pid(state):
    try:
        pid = int((state / 'desktop.pid').read_text())
        probe = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True, timeout=3)
        # ps flattens argv without quoting spaces (including Application Support).
        marker = r'(?:^|\s)--user-data-dir=' + re.escape(str(state / 'desktop')) + r'(?=\s--[\w-]|\s*$)'
        return pid if re.search(marker, probe.stdout) else None
    except (OSError, ValueError):
        return None


UNVERIFIED = 'unverified-bridge-activity'
RUNTIME_RECORD = re.compile(r'(\d+)-([\da-f-]{36})\.json')


def bridge_processes():
    """Return live bridge.mjs processes as pid -> (parent pid, start time)."""
    result = subprocess.run(['ps', '-axo', 'pid=,ppid=,lstart=,command='], capture_output=True, text=True,
                            timeout=5, env={**os.environ, 'LC_ALL': 'C'}, check=True)
    bridges, parents = {}, {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 7)
        if len(fields) < 7:
            continue
        pid, ppid = int(fields[0]), int(fields[1])
        parents[pid] = ppid
        if len(fields) == 8 and re.search(r'bridge\.mjs(?:\s|$)', fields[7]):
            bridges[pid] = (ppid, time.mktime(time.strptime(' '.join(fields[2:7]), '%a %b %d %H:%M:%S %Y')))
    return bridges, parents


def descends_from(pid, ancestor, parents):
    seen = set()
    while pid and pid not in seen:
        if pid == ancestor:
            return True
        seen.add(pid)
        pid = parents.get(pid)
    return False


def reject_constant(value):
    raise ValueError('Nonstandard JSON number')


def runtime_record(path, pid, run_id):
    # Regular files only; NaN/Infinity and booleans are not numbers here.
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW)) as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise ValueError('Runtime record is not a regular file')
        record = json.load(f, parse_constant=reject_constant)
    if not isinstance(record, dict):
        raise ValueError('Invalid runtime record')
    started, pending = record.get('startedAt'), record.get('pendingStarts')
    lists = [record.get('activeThreads'), record.get('startingThreads')]
    if (type(record.get('pid')) is not int or record['pid'] != pid or record.get('runId') != run_id
            or type(started) not in (int, float) or not math.isfinite(started) or started <= 0
            or not all(type(v) is list and all(type(t) is str for t in v) for v in lists)
            or type(pending) is not int or pending < 0):
        raise ValueError('Invalid runtime record')
    return record


def active_threads(state, desktop=None):
    # Every live Bridge instance must report its own work. Missing, malformed or
    # unreadable evidence is unverified activity, never idle. Logs are not used.
    active = []
    try:
        bridges, parents = bridge_processes()
        directory = state / 'runtime'
        try:
            mode = os.lstat(directory).st_mode
        except FileNotFoundError:
            names = []
        else:
            if not stat.S_ISDIR(mode):
                return [UNVERIFIED]  # Includes a redirected runtime directory.
            names = os.listdir(directory)
    except (OSError, ValueError, subprocess.SubprocessError):
        return [UNVERIFIED]
    verified = set()
    for name in names:
        match = RUNTIME_RECORD.fullmatch(name)
        pid = int(match[1]) if match else None
        if pid not in bridges:
            continue  # Ended instance, or its PID now belongs to a non-Bridge process.
        try:
            record = runtime_record(directory / name, pid, match[2])
        except (OSError, ValueError):
            active.append(UNVERIFIED)
            continue
        if abs(record['startedAt'] / 1000 - bridges[pid][1]) > 3:
            continue  # Written by an earlier process that had this PID.
        verified.add(pid)
        work = record['activeThreads'] + record['startingThreads']
        active.extend(work or (['turn-starting'] if record['pendingStarts'] else []))
    if desktop and any(pid not in verified and descends_from(pid, desktop, parents) for pid in bridges):
        active.append(UNVERIFIED)
    for path in (state / 'threads').glob('*.json'):
        record = json.loads(path.read_text())
        if any(turn.get('status') == 'inProgress' for turn in record.get('turns', [])):
            active.append(path.stem)
    return sorted(set(active))


def validate_paths(state, source):
    if state == source or state in source.parents or source in state.parents:
        raise RuntimeError('Source and isolated state must be separate, non-nested directories.')
    marker = state / 'snapshot.json'
    if marker.exists():
        snapshot = json.loads(marker.read_text())
        if Path(snapshot['source']).resolve() != source or Path(snapshot['isolated']).resolve() != state / 'codex':
            raise RuntimeError('This profile belongs to another source. Use its original source or a new --state.')
    for name in ['codex', 'desktop', 'threads', 'logs', 'runtime']:
        if (state / name).is_symlink():
            raise RuntimeError('Isolated profile directories must not be symlinks.')


def claude_path():
    return shutil.which('claude') or next((str(p) for p in [Path.home() / '.local/bin/claude', Path('/opt/homebrew/bin/claude'), Path('/usr/local/bin/claude')] if p.is_file()), None)


def preflight(state, source, app):
    validate_paths(state, source)
    if not source.is_dir():
        raise RuntimeError('Codex source profile was not found. Start Codex normally once, or select --source.')
    resources = app / 'Contents/Resources'
    node = resources / 'cua_node/bin/node'
    real = resources / 'codex-cli/CodexCLI.app/Contents/MacOS/codex'
    if not all(p.is_file() for p in [node, real, app / 'Contents/Info.plist']):
        raise RuntimeError('This app does not contain the supported Codex CLI and signed Node runtime. Select --app.')
    claude = claude_path()
    if not claude:
        raise RuntimeError('Install the official Claude Code CLI and run claude auth login first.')
    # Match the SDK child environment, without reading/exporting login tokens.
    auth_env = {k: v for k, v in os.environ.items() if not k.startswith('ANTHROPIC_') and
                k not in ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']}
    try:
        auth_result = subprocess.run([claude, 'auth', 'status', '--json'], env=auth_env, capture_output=True, text=True, timeout=20)
        auth = json.loads(auth_result.stdout)
    except (ValueError, subprocess.TimeoutExpired, OSError):
        raise RuntimeError('Claude login status could not be verified. Run claude auth status locally.') from None
    if auth_result.returncode or auth.get('loggedIn') is not True:
        raise RuntimeError('Claude Code is not logged in. Run claude auth login, then try setup again.')
    if auth.get('authMethod') != 'claude.ai' or auth.get('apiProvider') != 'firstParty':
        raise RuntimeError('This bridge expects an official Claude subscription login. Use claude auth login for that account.')
    def version(command):
        result = subprocess.run([str(command), '--version'], capture_output=True, text=True, timeout=15)
        match = re.search(r'\d+\.\d+\.\d+[\w.\-]*', result.stdout)
        if result.returncode or not match:
            raise RuntimeError('A runtime version could not be verified. Run doctor after checking the installed CLIs.')
        return match.group()
    config_file = source / 'config.toml'
    config = tomllib.loads(config_file.read_text()) if config_file.exists() else {}
    provider = config.get('model_providers', {}).get(config.get('model_provider'), {})
    missing_key = bool(provider.get('env_key') and not os.environ.get(provider['env_key']))
    if missing_key:
        raise RuntimeError('The configured GPT provider environment key is missing. Launch from the same configured environment as Codex; do not copy the key into bridge files.')
    with (app / 'Contents/Info.plist').open('rb') as f:
        info = plistlib.load(f)
    return {'ok': True, 'pythonVersion': '.'.join(map(str, sys.version_info[:3])),
            'appVersion': info.get('CFBundleShortVersionString'), 'providerEnvironmentReady': not missing_key,
            'codexVersion': version(real), 'claudeVersion': version(claude), 'nodeVersion': version(node),
            'signedRuntimePresent': True, 'claudeInstalled': True, 'claudeAuthenticated': True,
            'subscriptionLogin': True, 'transport': 'stdio', 'modelProxy': False}


def rebase_config(text, source, isolated):
    # Only app-generated paths belong to the new profile. User-selected local
    # marketplaces and other source paths must keep their original meaning.
    updated = re.sub(r'(?m)^(\s*path\s*=\s*[\"\'])' + re.escape(str(source / 'skills')) + r'(?=/)',
                     lambda m: m.group(1) + str(isolated / 'skills'), text)
    marketplace = tomllib.loads(updated).get('marketplaces', {}).get('openai-bundled', {})
    generated = Path('.tmp/bundled-marketplaces/openai-bundled')
    if marketplace.get('source_type') == 'local' and marketplace.get('source') == str(source / generated):
        section = r'(?ms)(^\[marketplaces\.openai-bundled\][^\n]*\n)(.*?)(?=^\[|\Z)'
        updated = re.sub(section, lambda m: m.group(1) + re.sub(
            r'(?m)^(\s*source\s*=\s*)(?:"[^"\n]*"|\'[^\'\n]*\')',
            lambda line: line.group(1) + json.dumps(str(isolated / generated)), m.group(2)), updated)
    return updated


def wrapper_script(node, real, state, source, claude):
    # Native plugins reuse CODEX_CLI_PATH for helper subcommands in a restricted
    # environment. They must exec the real binary directly, without a Node
    # intermediary or any dependence on inherited BRIDGE_* variables.
    settings = {'BRIDGE_REAL_CODEX': str(real), 'BRIDGE_STATE': str(state / 'threads'),
                'BRIDGE_SOURCE_CODEX_HOME': str(source), 'BRIDGE_CLAUDE': claude}
    return ('#!/bin/sh\nbridge_app_server=\n'
            'for bridge_argument do\n'
            '  if [ "$bridge_argument" = app-server ]; then bridge_app_server=1; fi\n'
            'done\n'
            'if [ "$bridge_app_server" != 1 ]; then\n'
            '  export CODEX_CLI_PATH=' + shlex.quote(str(real)) + '\n'
            '  exec ' + shlex.quote(str(real)) + ' "$@"\nfi\n' +
            ''.join('export ' + key + '=' + shlex.quote(value) + '\n' for key, value in settings.items()) +
            'exec ' + shlex.quote(node) + ' ' + shlex.quote(str(ROOT / 'bridge.mjs')) + ' "$@"\n')


def prepare(state, source, app, *, copy_auth=True):
    validate_paths(state, source)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state, 0o700)
    profile = state / 'desktop'
    isolated = state / 'codex'
    isolated.mkdir(exist_ok=True, mode=0o700)
    profile.mkdir(exist_ok=True, mode=0o700)
    # Snapshot config and packages, never share a writable home or session DB.
    # On APFS, clonefile avoids physically duplicating the package cache.
    marker = state / 'snapshot.json'
    if not marker.exists():
        for name in ['config.toml', 'AGENTS.md', 'auth.json', 'models_cache.json']:
            if name == 'auth.json' and not copy_auth:
                continue
            path = source / name
            if path.is_file():
                shutil.copy2(path, isolated / name)
                os.chmod(isolated / name, 0o600)
        for name in ['skills', 'plugins']:
            path = source / name
            if path.is_dir():
                subprocess.run(['/bin/cp', '-cR', str(path), str(isolated / name)], check=True)
        marker.write_text(json.dumps({'source': str(source), 'isolated': str(isolated)}, indent=2))
    # Absolute skill selectors must address the copied skill, including disabled ones.
    # This small idempotent migration also repairs snapshots made by earlier builds.
    config_file = isolated / 'config.toml'
    if config_file.exists():
        original = config_file.read_text()
        updated = rebase_config(original, source, isolated)
    else:
        original = updated = ''
    # The desktop also reloads provider settings outside the initial CLI process.
    # Register the bridge only in its isolated profile, including those reloads.
    if 'claude_code' not in tomllib.loads(updated).get('model_providers', {}):
        updated += '\n[model_providers.claude_code]\nname = "Claude Code bridge"\nbase_url = "http://127.0.0.1:1/disabled"\nwire_api = "responses"\nrequires_openai_auth = false\n'
    if updated != original:
        backup = isolated / 'config.before-bridge-migration.toml'
        if config_file.exists() and not backup.exists():
            shutil.copy2(config_file, backup)
            backup.chmod(0o600)
        config_file.write_text(updated)
        config_file.chmod(0o600)
    # Keep the bridge and native MCP helpers on the selected app's runtime.
    # Inserting a different Node build between desktop and its native server
    # changes the process ancestry used by the desktop's normal peer checks.
    bundled_node = app / 'Contents/Resources/cua_node/bin/node'
    node = str(bundled_node) if bundled_node.is_file() else shutil.which('node')
    claude = claude_path()
    if not node or not claude:
        raise RuntimeError('Node.js and Claude Code must already be installed.')
    real = app / 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
    if not real.is_file():
        raise RuntimeError('Bundled Codex CLI not found in this app.')
    wrapper = state / 'codex-bridge'
    wrapper.write_text(wrapper_script(node, real, state, source, claude))
    wrapper.chmod(0o700)
    env = dict(os.environ)
    # Provider credentials and HTTP headers explicitly named by configuration
    # are not desktop session/IPC state. Retain their environment values in memory;
    # never copy their values to configuration, wrapper scripts or logs.
    providers = tomllib.loads(updated).get('model_providers', {}).values()
    provider_env = {name for v in providers for name in
                    [v.get('env_key'), *v.get('env_http_headers', {}).values()] if name}
    # These are the application's documented/implemented home and profile settings,
    # scoped only to the new process; the caller's environment is not modified.
    for key in list(env):
        if (key.startswith('CODEX_') and key not in provider_env) or key == 'ELECTRON_RUN_AS_NODE':
            env.pop(key)
    env.update({
        'CODEX_HOME': str(isolated), 'CODEX_ELECTRON_USER_DATA_PATH': str(profile),
        'CODEX_CLI_PATH': str(wrapper), 'BRIDGE_REAL_CODEX': str(real),
        'BRIDGE_SOURCE_CODEX_HOME': str(source), 'BRIDGE_STATE': str(state / 'threads'),
        'BRIDGE_CLAUDE': claude,
        'BRIDGE_PYTHON': sys.executable,
    })
    # The stock plugin launcher explicitly consumes this runtime hint. Removing
    # it sends desktop MCP servers to an unrelated fallback Node installation.
    # Use the selected app's own runtime; never reuse another app's pipe/context.
    if bundled_node.is_file():
        env['CODEX_MCP_NODE_PATH'] = str(bundled_node)
    with (app / 'Contents/Info.plist').open('rb') as f:
        executable = app / 'Contents/MacOS' / plistlib.load(f)['CFBundleExecutable']
    return env, executable, wrapper


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', type=Path, default=DEFAULT_STATE)
    parser.add_argument('--source', type=Path, default=Path.home() / '.codex')
    parser.add_argument('--app', type=Path, default=Path('/Applications/ChatGPT.app'))
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--stdio', action='store_true')
    parser.add_argument('--no-auth-copy', action='store_true', help='Prepare a profile without copying Codex auth.json')
    parser.add_argument('--stop', action='store_true')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    state = args.state.resolve()
    if args.check:
        print(json.dumps(preflight(state, args.source.resolve(), args.app.resolve())))
        return
    if args.status:
        pid = running_pid(state)
        print(json.dumps({'pid': pid, 'running': bool(pid), 'activeThreads': active_threads(state, pid) if pid else []}))
        return
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Serializes simultaneous launch/stop commands; no daemon or extra service.
    lock = (state / 'launcher.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    pid = running_pid(state)
    if args.stop:
        if pid:
            active = active_threads(state, pid)
            if UNVERIFIED in active:
                raise RuntimeError('Bridge activity could not be verified, so it was not stopped. A Bridge process without a valid runtime record, including one started by an earlier version, stays unverified until it exits; retrying does not change that. Run codex-claude doctor.')
            if active:
                raise RuntimeError('A chat is active. Stop its turn in Codex before restarting the bridge.')
            os.kill(pid, 15)
            deadline = time.monotonic() + 15
            while running_pid(state) and time.monotonic() < deadline:
                time.sleep(0.2)
            if running_pid(state):
                raise RuntimeError('The isolated app has not exited yet. It was not force-killed.')
        print(json.dumps({'running': False, 'state': str(state)}))
        return
    if pid and not args.stdio and not args.prepare:
        print(json.dumps({'pid': pid, 'state': str(state), 'alreadyRunning': True}))
        return
    env, executable, wrapper = prepare(state, args.source.resolve(), args.app.resolve(), copy_auth=not args.no_auth_copy)
    if args.prepare:
        print(json.dumps({'state': str(state), 'wrapper': str(wrapper), 'source_config': str(args.source)}))
    elif args.stdio:
        os.execve(str(wrapper), [str(wrapper), 'app-server'], env)
    else:
        pid_file = state / 'desktop.pid'
        # Raw desktop output is local only and never included in doctor reports.
        # Bound it too: it may contain native errors outside our metadata logger.
        desktop_log = state / 'desktop.log'
        if desktop_log.exists() and desktop_log.stat().st_size > 4 * 1024 * 1024:
            desktop_log.replace(state / 'desktop.log.1')
        with (state / 'desktop.log').open('ab') as log:
            os.chmod(state / 'desktop.log', 0o600)
            (state / 'desktop-log-offset').write_text(str(log.tell()))
            process = subprocess.Popen([str(executable), '--user-data-dir=' + str(state / 'desktop')],
                                       env=env, stdout=log, stderr=log, start_new_session=True)
        pid_file.write_text(str(process.pid))
        pid_file.chmod(0o600)
        time.sleep(1)
        if process.poll() is not None:
            raise RuntimeError('Isolated desktop exited at startup. Run codex-claude doctor.')
        print(json.dumps({'pid': process.pid, 'state': str(state)}))


if __name__ == '__main__':
    main()

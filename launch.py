#!/usr/bin/env python3
"""Launch the installed, unmodified Codex app with an isolated runtime/profile."""
import argparse
from datetime import datetime
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
# A live Bridge republishes its record every 5 seconds (logging.mjs). An older
# record is not idle evidence. This is supplemental to the nice-value signal.
RUNTIME_LEASE_SECONDS = 20
# A Bridge that cannot record or invalidate its work raises its own nice value
# by one (logging.mjs). At this value it can signal no further, so it is never
# treated as verified.
LOWEST_SIGNALLING_NICE = 19


def bridge_processes():
    """Return live bridge.mjs processes as pid -> (parent pid, start time, nice or None)."""
    result = subprocess.run(['ps', '-axo', 'pid=,ppid=,nice=,lstart=,command='], capture_output=True, text=True,
                            timeout=5, env={**os.environ, 'LC_ALL': 'C'}, check=True)
    bridges, parents = {}, {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 8)
        if len(fields) < 8:
            continue
        pid, ppid = int(fields[0]), int(fields[1])
        parents[pid] = ppid
        if len(fields) == 9 and re.search(r'bridge\.mjs(?:\s|$)', fields[8]):
            nice = int(fields[2]) if re.fullmatch(r'-?\d+', fields[2]) else None
            bridges[pid] = (ppid, time.mktime(time.strptime(' '.join(fields[3:8]), '%a %b %d %H:%M:%S %Y')), nice)
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
            or type(pending) is not int or pending < 0 or type(record.get('updatedAt')) is not str
            or type(record.get('nice')) is not int):
        raise ValueError('Invalid runtime record')
    updated = datetime.fromisoformat(record['updatedAt'].replace('Z', '+00:00'))
    if updated.tzinfo is None:
        raise ValueError('Runtime record time has no zone')
    record['updatedAt'] = updated.timestamp()
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
        nice = bridges[pid][2]
        if nice is None or nice >= LOWEST_SIGNALLING_NICE or record['nice'] != nice:
            # The process signalled that this record may understate its work, or
            # its signal is unknown. No file write is needed for this to hold.
            active.append(UNVERIFIED)
            continue
        if not -5 <= time.time() - record['updatedAt'] <= RUNTIME_LEASE_SECONDS:
            active.append(UNVERIFIED)  # Expired lease: current work is unconfirmed.
            continue
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


def preflight(state, source, app, *, primary=False):
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
    # The primary app is opened by macOS with its usual environment, not this shell's.
    missing_key = not primary and bool(provider.get('env_key') and not os.environ.get(provider['env_key']))
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


def wrapper_script(node, real, state, source, claude, *, primary=False, isolated=None):
    # Native plugins reuse CODEX_CLI_PATH for helper subcommands in a restricted
    # environment. They must exec the real binary directly, without a Node
    # intermediary or any dependence on inherited BRIDGE_* variables.
    # Primary mode has no copied profile to mirror; its GPT chats get the session tools.
    settings = {'BRIDGE_REAL_CODEX': str(real), 'BRIDGE_STATE': str(state / 'threads'), 'BRIDGE_CLAUDE': claude,
                **({'BRIDGE_COORDINATOR': '1'} if primary else {'BRIDGE_SOURCE_CODEX_HOME': str(source)})}
    # The primary Bridge must never serve the separate test profile, even if its
    # settings were inherited: it refuses to start rather than select that profile.
    refuse = ''.join(
        f'case "${{{key}:-}}" in {shlex.quote(str(path))}|{shlex.quote(str(path))}/*)\n'
        '  echo "Codex + Claude: this app was given the separate test profile, so the Bridge did not start." >&2; exit 78;;\nesac\n'
        for key, path in [('CODEX_HOME', isolated / 'codex'), ('CODEX_ELECTRON_USER_DATA_PATH', isolated / 'desktop')]) if primary and isolated else ''
    return ('#!/bin/sh\nbridge_app_server=\n'
            'for bridge_argument do\n'
            '  if [ "$bridge_argument" = app-server ]; then bridge_app_server=1; fi\n'
            'done\n'
            'if [ "$bridge_app_server" != 1 ]; then\n'
            '  export CODEX_CLI_PATH=' + shlex.quote(str(real)) + '\n'
            '  exec ' + shlex.quote(str(real)) + ' "$@"\nfi\n' + refuse +
            ('unset BRIDGE_SOURCE_CODEX_HOME BRIDGE_MIRROR\n' if primary else 'unset BRIDGE_COORDINATOR\n') +
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


PRIMARY_BUNDLE_ID = 'com.openai.codex'
OPEN = '/usr/bin/open'
CODESIGN = '/usr/bin/codesign'
PRIMARY_START_SECONDS = 30
# Signed CLI layouts inside the app, newest first.
CLI_LAYOUTS = ['Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', 'Contents/Resources/codex']


def primary_app(app):
    """The selected app's identity, main executable and bundled CLI, unchanged and signed."""
    try:
        with (app / 'Contents/Info.plist').open('rb') as f:
            info = plistlib.load(f)
    except (OSError, plistlib.InvalidFileException):
        raise RuntimeError('The selected app could not be read. Select the Codex app with --app.') from None
    if info.get('CFBundleIdentifier') != PRIMARY_BUNDLE_ID or not isinstance(info.get('CFBundleExecutable'), str):
        raise RuntimeError('The selected app is not the Codex desktop app (com.openai.codex). Select it with --app.')
    executable = app / 'Contents/MacOS' / info['CFBundleExecutable']
    real = next((app / p for p in CLI_LAYOUTS if (app / p).is_file() and os.access(app / p, os.X_OK)), None)
    if not executable.is_file() or not real:
        raise RuntimeError('This app does not contain its bundled Codex CLI. Select the Codex app with --app.')
    try:
        signed = subprocess.run([CODESIGN, '--verify', '--strict', str(app)], capture_output=True, timeout=120).returncode == 0
    except (OSError, subprocess.SubprocessError):
        signed = False
    if not signed:
        raise RuntimeError('The selected app failed its code-signature check, so it was not opened.')
    return executable, real


def process_table():
    """pid -> (parent pid, full command). Wide output, so commands are not truncated."""
    result = subprocess.run(['ps', '-axww', '-o', 'pid=,ppid=,command='], capture_output=True, text=True, timeout=5,
                            env={**os.environ, 'LC_ALL': 'C'}, check=True)
    table = {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 2)
        if len(fields) >= 2 and fields[0].isdigit() and fields[1].isdigit():
            table[int(fields[0])] = (int(fields[1]), fields[2] if len(fields) == 3 else '')
    return table


def app_processes(executable, table=None):
    """PIDs of any running copy of this app (main process or bundled helpers), or None if unknown."""
    try:
        table = process_table() if table is None else table
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    bundle = str(executable.parent.parent.parent) + '/'
    name = re.escape('/Contents/MacOS/' + executable.name)
    return {pid: command for pid, (_, command) in table.items()
            if pid != os.getpid() and (command.startswith(bundle) or re.search(name + r'(?:\s|$)', command))}


def primary_bridges(root, table):
    """Live processes running this checkout's bridge.mjs whose runtime record is in this state."""
    directory, program = root / 'runtime', str(ROOT / 'bridge.mjs')
    if directory.is_symlink():
        raise OSError('Runtime directory is a symlink')
    found = {}
    for name in os.listdir(directory) if directory.is_dir() else []:
        match = RUNTIME_RECORD.fullmatch(name)
        pid = int(match[1]) if match else None
        if pid in table and program in table[pid][1]:
            try:
                found[pid] = runtime_record(directory / name, pid, match[2])
            except (OSError, ValueError):
                found[pid] = None  # Live, but its record is unreadable.
    return found


def write_private(path, text):
    # A fresh file renamed into place: an existing link is replaced, not followed.
    temp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
    with os.fdopen(fd, 'w') as f:
        f.write(text)
    os.replace(temp, path)


def process_start(pid):
    """A live process's start time (Unix seconds) from public `ps`, or None if unknown."""
    try:
        result = subprocess.run(['ps', '-o', 'lstart=', '-p', str(pid)], capture_output=True, text=True, timeout=3,
                                env={**os.environ, 'LC_ALL': 'C'})
        return time.mktime(time.strptime(result.stdout.strip(), '%a %b %d %H:%M:%S %Y')) if result.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def primary_bridge(executable, root, since=None):
    """(primary app pid, this state's Bridge running under it); None means unknown.

    Only a process that runs this checkout's bridge.mjs, descends from the one
    primary app process and published a current record in this state counts:
    the record's start time matches that process's actual start (so a stale
    record or a reused PID does not), its lease is fresh and it is not stopping.
    With since, the Bridge must also have started after that launch time.
    Evidence that is unreadable, unconfirmable, expired or stopping is unknown.
    """
    try:
        table = process_table()
    except (OSError, ValueError, subprocess.SubprocessError):
        return None, None
    main = [pid for pid, command in app_processes(executable, table).items()
            if (command == str(executable) or command.startswith(str(executable) + ' ')) and '--user-data-dir=' not in command]
    if len(main) != 1:
        return None, False
    try:
        bridges = primary_bridges(root, table)
    except OSError:
        return main[0], None
    parents = {pid: parent for pid, (parent, _) in table.items()}
    observed = False
    for pid, record in bridges.items():
        if not descends_from(pid, main[0], parents):
            continue
        started = process_start(pid) if record else None
        if record is None or started is None:
            observed = None
        elif abs(record['startedAt'] / 1000 - started) > 3:
            continue  # Written by an earlier process that had this PID.
        elif record.get('stopping') is not False or not -5 <= time.time() - record['updatedAt'] <= RUNTIME_LEASE_SECONDS:
            observed = None
        elif since is None or record['startedAt'] / 1000 >= since - 2:
            return main[0], True
    return main[0], observed


def primary_stopped(state, payload):
    """Confirm no Bridge from this payload runs, before the payload is replaced.

    Never stops anything. Any live process running this payload's bridge.mjs
    (primary or separate window), or any live Bridge with a record in this
    primary state, means it is not stopped; process information that cannot be
    read means unknown. Both refuse.
    """
    program = str(payload / 'bridge.mjs')
    directory = state / 'primary' / 'runtime'
    try:
        table = process_table()
        if directory.is_symlink():
            raise OSError('Runtime directory is a symlink')
        names = os.listdir(directory) if directory.is_dir() else []
    except (OSError, ValueError, subprocess.SubprocessError):
        raise RuntimeError('Whether a Codex + Claude Bridge is still running could not be checked, so nothing was replaced.') from None
    running = [pid for pid, (_, command) in table.items() if program in command]
    for name in names:
        match = RUNTIME_RECORD.fullmatch(name)
        pid = int(match[1]) if match else None
        if pid in table and re.search(r'bridge\.mjs(?:\s|$)', table[pid][1]):
            running.append(pid)  # A record whose PID is a dead or unrelated process is stale.
    if running:
        raise RuntimeError('A Codex + Claude Bridge from this installation is still running. Quit Codex (and the separate test window) yourself once its chats are idle, then run the installer again. Nothing was replaced.')
    return {'stopped': True, 'state': str(state / 'primary')}


def start_primary(state, app):
    """Open the unchanged primary app once with this Bridge as its app-server.

    Uses the app's normal profile and history: nothing is copied and no Codex
    configuration is changed. The setting applies to this one launch only.
    """
    executable, real = primary_app(app)
    root = state / 'primary'
    for path in [state, root, *(root / name for name in ['threads', 'logs', 'runtime'])]:
        if path.is_symlink():
            raise RuntimeError('Bridge state directories must not be symlinks.')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    lock = (root / 'launcher.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise RuntimeError('Another Codex + Claude launch is in progress.') from None
    try:
        table = process_table()
        earlier = primary_bridges(root, table)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise RuntimeError('Whether Codex is running could not be checked, so it was not opened.') from None
    if app_processes(executable, table):
        raise RuntimeError('Codex is already running. Quit it yourself once its chats are idle, then try again. Nothing was changed.')
    # A Bridge from an earlier primary launch must have exited with its app.
    if earlier:
        raise RuntimeError('A Codex + Claude Bridge from an earlier launch is still running. Wait for it to exit, then try again.')
    claude = claude_path()
    if not claude:
        raise RuntimeError('Install the official Claude Code CLI and run claude auth login first.')
    node = app / 'Contents/Resources/cua_node/bin/node'
    node = str(node) if node.is_file() else shutil.which('node')
    if not node:
        raise RuntimeError('Node.js must already be installed.')
    wrapper = root / 'codex-bridge'
    write_private(wrapper, wrapper_script(node, real, root, None, claude, primary=True, isolated=state))
    # Only this launch receives the setting. Codex, Bridge and Electron settings
    # of this shell, such as the separate test profile's, are not passed on.
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('CODEX_', 'BRIDGE_')) and key != 'ELECTRON_RUN_AS_NODE'}
    launched = time.time()
    try:
        opened = subprocess.run([OPEN, '-a', str(app), '--env', f'CODEX_CLI_PATH={wrapper}'], env=env,
                                capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        opened = None
    if not opened or opened.returncode:
        raise RuntimeError('macOS could not open Codex. Nothing else was changed.')
    deadline = time.monotonic() + PRIMARY_START_SECONDS
    pid = None
    while time.monotonic() < deadline:
        pid, bridged = primary_bridge(executable, root, since=launched)
        if bridged:
            return {'mode': 'primary', 'pid': pid, 'bridge': True, 'state': str(root)}
        time.sleep(0.5)
    if pid:
        raise RuntimeError('Codex opened, but its Claude Bridge was not observed. GPT works as usual; Claude is unavailable in this window. Quit Codex when its chats are idle and try again, or run codex-claude doctor.')
    raise RuntimeError('Codex did not start. Run codex-claude doctor.')


def primary_status(state, app):
    executable, _ = primary_app(app)
    pid, bridged = primary_bridge(executable, state / 'primary')
    return {'mode': 'primary', 'pid': pid, 'running': None if bridged is None and pid is None else bool(pid), 'bridge': bridged,
            'activeThreads': active_threads(state / 'primary', pid) if pid else []}


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
    parser.add_argument('--primary', action='store_true', help='Open the normal Codex app once with the Bridge (no profile copy)')
    parser.add_argument('--stopped', action='store_true', help='With --primary: confirm no Bridge from --payload runs (for replacement)')
    parser.add_argument('--payload', type=Path, help='Installed package directory checked by --stopped (default: this one)')
    args = parser.parse_args()
    state = args.state.resolve()
    if args.check:
        print(json.dumps(preflight(state, args.source.resolve(), args.app.resolve(), primary=args.primary)))
        return
    if args.primary:
        if args.stop or args.prepare or args.stdio or args.no_auth_copy:
            raise RuntimeError('Primary mode only opens Codex or reports status. Quit Codex yourself when its chats are idle.')
        if args.stopped:
            print(json.dumps(primary_stopped(state, (args.payload or ROOT).resolve())))
            return
        app = args.app.resolve()
        print(json.dumps(primary_status(state, app) if args.status else start_primary(state, app)))
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

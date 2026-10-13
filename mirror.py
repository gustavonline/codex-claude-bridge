#!/usr/bin/env python3
"""Continuous configuration mirror; excludes auth, history, DBs and runtimes.

The launcher's initial desktop preparation has a separate one-time auth snapshot.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
from launch import rebase_config


def replace(path, content):
    if path.is_file() and path.read_bytes() == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.bridge-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(content)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return True


def mirror(source, state):
    source, state = source.resolve(), state.resolve()
    target = state / 'codex'
    snapshot = json.loads((state / 'snapshot.json').read_text())
    if Path(snapshot['source']).resolve() != source or Path(snapshot['isolated']).resolve() != target:
        raise ValueError('Mirror must match the isolated profile snapshot')
    if source == target or source in target.parents or target in source.parents:
        raise ValueError('Source and mirror must be separate profiles')
    with (state / 'mirror.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'changed': False, 'busy': True}
        original = (source / 'config.toml').read_text() if (source / 'config.toml').exists() else ''
        config = rebase_config(original, source, target)
        parsed = tomllib.loads(config)  # Reject an incomplete source write before touching the mirror.
        if 'claude_code' not in parsed.get('model_providers', {}):
            config += '\n[model_providers.claude_code]\nname = "Claude Code bridge"\nbase_url = "http://127.0.0.1:1/disabled"\nwire_api = "responses"\nrequires_openai_auth = false\n'
        changed = 0
        # Never let a destination directory link redirect writes into the
        # source profile (or any other location outside this isolated profile).
        for relative in ['skills', 'plugins', 'plugins/cache']:
            path = target / relative
            if path.is_symlink() or not path.resolve().is_relative_to(target):
                raise ValueError('Mirror destination must not redirect through directory links')
        # These directories belong to the snapshot. App-generated runtimes,
        # OAuth stores and per-thread databases are deliberately outside scope.
        for relative in ['skills', 'plugins/cache']:
            src, dst = source / relative, target / relative
            if src.is_dir():
                dst.mkdir(parents=True, exist_ok=True)
                # Compare contents and executable permissions, not timestamps:
                # the desktop regularly touches its plugin installation markers.
                # Mirroring those touches would create an endless reload loop.
                result = subprocess.run(['/usr/bin/rsync', '-rlpc', '--delete', '--delay-updates', '--itemize-changes',
                                         '--exclude=.DS_Store', str(src) + '/', str(dst) + '/'],
                                        capture_output=True, text=True, check=True)
                # macOS rsync still reports .f..T.... for untouched files when
                # times are not copied. Those are observations, not transfers.
                for line in result.stdout.splitlines():
                    code = line.split(' ', 1)[0]
                    timestamp_only = code.startswith('.') and len(code) >= 2 and set(code[2:]) <= {'.', 't', 'T'}
                    changed += not timestamp_only
            elif dst.exists():
                shutil.rmtree(dst)
                changed += 1
        agents = source / 'AGENTS.md'
        if agents.is_file():
            changed += replace(target / 'AGENTS.md', agents.read_bytes())
        elif (target / 'AGENTS.md').exists():
            (target / 'AGENTS.md').unlink()
            changed += 1
        # Commit activation/config last, after its referenced package files exist.
        changed += replace(target / 'config.toml', config.encode())
        return {'changed': bool(changed), 'changedEntries': changed}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--state', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(mirror(args.source, args.state)))

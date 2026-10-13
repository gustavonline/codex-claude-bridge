#!/bin/sh
set -eu
# The verified tarball is installed as a root package so npm cannot re-resolve
# its peer/transitive dependencies while hoisting it into another project.
bridge_runtime_archive=$1
bridge_runtime_prefix=$2
shift 2
bridge_runtime_root="$bridge_runtime_prefix/node_modules/codex-claude-bridge-local"
mkdir -p "$bridge_runtime_root" "$bridge_runtime_prefix/node_modules/.bin"
tar -xzf "$bridge_runtime_archive" -C "$bridge_runtime_root" --strip-components=1
npm ci --prefix "$bridge_runtime_root" --ignore-scripts --omit=optional --no-audit --no-fund "$@"
chmod 755 "$bridge_runtime_root/cli.mjs"
ln -s ../codex-claude-bridge-local/cli.mjs "$bridge_runtime_prefix/node_modules/.bin/codex-claude"

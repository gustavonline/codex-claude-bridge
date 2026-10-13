#!/bin/sh
set -eu
bridge_source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec sh "$bridge_source_dir/plugins/codex-claude/install.command" "$@"

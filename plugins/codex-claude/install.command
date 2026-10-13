#!/bin/sh
set -eu
bridge_bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bridge_parent="$HOME/.local/share"
bridge_install_dir="$bridge_parent/codex-claude-bridge"
bridge_backup="$bridge_parent/codex-claude-bridge.previous"
bridge_lock="$bridge_parent/.codex-claude-install-lock"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ "$(uname -s)" = Darwin ] || { echo 'Model Bridge currently runs on macOS.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 && node -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)' || {
  echo 'Install Node.js 22 or newer, then retry.' >&2; exit 1;
}
[ -f "$bridge_bundle_dir/bundle.json" ] || { echo 'Build with npm run bundle -- --pin, or download a release bundle first.' >&2; exit 1; }
bridge_version=$(node -e 'const d=require(process.argv[1]); if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(d.version) || !/^[a-f0-9]{64}$/.test(d.sha256)) process.exit(1); console.log(d.version)' "$bridge_bundle_dir/bundle.json")
bridge_sha=$(node -p 'require(process.argv[1]).sha256' "$bridge_bundle_dir/bundle.json")
bridge_asset="codex-claude-bridge-local-$bridge_version.tgz"
mkdir -p "$bridge_parent"
mkdir "$bridge_lock" 2>/dev/null || { echo 'Another installation is active. Inspect it before removing the installation lock.' >&2; exit 1; }
bridge_stage=$(mktemp -d "$bridge_parent/.codex-claude-stage.XXXXXX")
bridge_replaced=0
bridge_had_previous=0
bridge_success=0
cleanup() {
  bridge_exit=$?
  if [ "$bridge_replaced" = 1 ] && [ "$bridge_success" != 1 ]; then
    if [ "$bridge_had_previous" = 1 ] && [ -d "$bridge_backup" ]; then
      rm -rf "$bridge_install_dir"
      mv "$bridge_backup" "$bridge_install_dir"
    elif [ "$bridge_had_previous" = 0 ]; then
      rm -rf "$bridge_install_dir"
    fi
    echo 'Installation did not finish. The previous package was restored where available; profile data was preserved.' >&2
  fi
  rm -rf "$bridge_stage"
  rmdir "$bridge_lock"
  exit "$bridge_exit"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -f "$bridge_bundle_dir/$bridge_asset" ]; then
  cp "$bridge_bundle_dir/$bridge_asset" "$bridge_stage/runtime.tgz"
elif command -v gh >/dev/null 2>&1 && gh release download "v$bridge_version" --repo gustavonline/codex-claude-bridge --pattern "$bridge_asset" --output "$bridge_stage/runtime.tgz"; then
  # GitHub owns repository authentication, including access to private previews.
  :
else
  curl --proto '=https' --tlsv1.2 -fLSs "https://github.com/gustavonline/codex-claude-bridge/releases/download/v$bridge_version/$bridge_asset" -o "$bridge_stage/runtime.tgz"
fi
bridge_actual=$(shasum -a 256 "$bridge_stage/runtime.tgz" | cut -d ' ' -f 1)
[ "$bridge_actual" = "$bridge_sha" ] || { echo 'Bundle checksum mismatch. Nothing was installed.' >&2; exit 1; }
if ! command -v claude >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -fLSs https://claude.ai/install.sh -o "$bridge_stage/claude-installer.sh"
  bash "$bridge_stage/claude-installer.sh"
fi
if ! claude auth status --json >/dev/null 2>&1; then
  echo 'Complete the official Claude Code login in its own flow.'
  claude auth login
fi
bridge_command="$bridge_install_dir/node_modules/.bin/codex-claude"
if [ -x "$bridge_command" ] && [ "$("$bridge_command" --version)" = "$bridge_version" ]; then
  "$bridge_command" setup "$@"
  "$bridge_command"
  bridge_success=1
  exit 0
fi
sh "$bridge_bundle_dir/stage-runtime.sh" "$bridge_stage/runtime.tgz" "$bridge_stage/package"
bridge_new="$bridge_stage/package/node_modules/.bin/codex-claude"
[ "$("$bridge_new" --version)" = "$bridge_version" ] || { echo 'Unexpected staged package version.' >&2; exit 1; }
# The public compatibility check uses a disposable profile and no model prompt.
"$bridge_new" check "$@" --state "$bridge_stage/check" --json >/dev/null
if [ -x "$bridge_command" ]; then "$bridge_command" stop; fi
if [ -e "$bridge_install_dir" ]; then
  [ ! -L "$bridge_install_dir" ] || { echo 'Installation directory is a symlink; left unchanged.' >&2; exit 1; }
  rm -rf "$bridge_backup"
  bridge_had_previous=1
  # Mark before the first rename. Recovery inspects whether the rename actually
  # happened, including a TERM delivered immediately after mv returns.
  bridge_replaced=1
  mv "$bridge_install_dir" "$bridge_backup"
fi
bridge_replaced=1
mv "$bridge_stage/package" "$bridge_install_dir"
"$bridge_command" setup "$@"
mkdir -p "$HOME/.local/bin"
if [ ! -e "$HOME/.local/bin/codex-claude" ] && [ ! -L "$HOME/.local/bin/codex-claude" ]; then
  ln -s "$bridge_command" "$HOME/.local/bin/codex-claude"
fi
"$bridge_command"
bridge_success=1

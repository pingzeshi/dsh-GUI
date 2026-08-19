#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 7 ]]; then
  echo "usage: $0 PROJECT_ROOT RUNTIME_ID NODE_VERSION NODE_SHA256 PNPM_VERSION DSH_VERSION ARCHIVE_NAME" >&2
  exit 2
fi

project_root=$1
runtime_id=$2
node_version=$3
node_sha256=$4
pnpm_version=$5
dsh_version=$6
archive_name=$7

[[ $project_root == /* ]] || { echo 'project root must be an absolute Linux path' >&2; exit 2; }
[[ $runtime_id =~ ^[a-z0-9][a-z0-9._-]+$ ]] || { echo 'invalid runtime id' >&2; exit 2; }
[[ $node_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'invalid Node.js version' >&2; exit 2; }
[[ $node_sha256 =~ ^[0-9a-f]{64}$ ]] || { echo 'invalid Node.js archive SHA-256' >&2; exit 2; }
[[ $pnpm_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'invalid pnpm version' >&2; exit 2; }
[[ $dsh_version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo 'invalid dsh version' >&2; exit 2; }
[[ $archive_name =~ ^[a-z0-9][a-z0-9._-]+\.tar\.gz$ ]] || { echo 'invalid archive name' >&2; exit 2; }

for command_name in curl tar xz gzip sha256sum install mktemp; do
  command -v "$command_name" >/dev/null || { echo "missing build command: $command_name" >&2; exit 1; }
done

runtime_dir="$project_root/runtime"
package_json="$runtime_dir/package.json"
pnpm_lock="$runtime_dir/pnpm-lock.yaml"
pnpm_workspace="$runtime_dir/pnpm-workspace.yaml"
notices="$runtime_dir/THIRD_PARTY_NOTICES.md"
[[ -f $package_json && -f $pnpm_lock && -f $pnpm_workspace && -f $notices ]] || {
  echo 'runtime package lock or notices are missing' >&2
  exit 1
}

work_dir=$(mktemp -d /tmp/dsh-desktop-runtime-build.XXXXXX)
cleanup() {
  if [[ $work_dir == /tmp/dsh-desktop-runtime-build.* ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT

node_archive="$work_dir/node.tar.xz"
node_dist="$work_dir/node-dist"
app_dir="$work_dir/app"
stage_dir="$work_dir/stage"
archive_tmp="$runtime_dir/.${archive_name}.tmp.$$"
manifest_tmp="$runtime_dir/.manifest.json.tmp.$$"
trap 'rm -f -- "$archive_tmp" "$manifest_tmp"; cleanup' EXIT

echo "Downloading Node.js v$node_version for linux-x64"
curl --fail --location --silent --show-error --retry 3 \
  "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz" \
  --output "$node_archive"
printf '%s  %s\n' "$node_sha256" "$node_archive" | sha256sum --check --status

mkdir -p "$node_dist" "$app_dir" "$stage_dir/bin" "$stage_dir/lib" \
  "$stage_dir/share/licenses/node" "$stage_dir/share/dsh-desktop"
tar -xJf "$node_archive" -C "$node_dist" --strip-components=1
[[ $("$node_dist/bin/node" --version) == "v$node_version" ]] || {
  echo 'downloaded Node.js version does not match configuration' >&2
  exit 1
}

cp "$package_json" "$pnpm_lock" "$pnpm_workspace" "$app_dir/"
echo "Installing @deepseek-ai/dsh@$dsh_version from the pinned lockfile"
(
  cd "$app_dir"
  export COREPACK_HOME="$work_dir/corepack"
  export PATH="$node_dist/bin:$PATH"
  corepack_ready=0
  for attempt in 1 2 3; do
    if "$node_dist/bin/corepack" prepare "pnpm@$pnpm_version" --activate; then
      corepack_ready=1
      break
    fi
    rm -rf -- "$COREPACK_HOME"
    sleep $((attempt * 2))
  done
  [[ $corepack_ready -eq 1 ]] || { echo 'unable to prepare pinned pnpm after 3 attempts' >&2; exit 1; }
  "$node_dist/bin/corepack" pnpm install \
    --prod --frozen-lockfile --ignore-scripts=false --reporter=append-only
)

dsh_script="$app_dir/node_modules/@deepseek-ai/dsh/lib/bin.js"
[[ -f $dsh_script ]] || { echo 'dsh entrypoint is missing after npm ci' >&2; exit 1; }
[[ $("$node_dist/bin/node" "$dsh_script" --version) == "$dsh_version" ]] || {
  echo 'installed dsh version does not match configuration' >&2
  exit 1
}

install -m 0755 "$node_dist/bin/node" "$stage_dir/bin/node"
install -m 0644 "$node_dist/LICENSE" "$stage_dir/share/licenses/node/LICENSE"
install -m 0644 "$notices" "$stage_dir/share/dsh-desktop/THIRD_PARTY_NOTICES.md"
install -m 0644 "$pnpm_lock" "$stage_dir/share/dsh-desktop/runtime-pnpm-lock.yaml"
mv "$app_dir/node_modules" "$stage_dir/lib/node_modules"
# The immutable runtime is never managed by pnpm after packaging. Its local
# metadata contains the build user's absolute store path and is not needed by
# Node's module resolver.
rm -f -- \
  "$stage_dir/lib/node_modules/.modules.yaml" \
  "$stage_dir/lib/node_modules/.pnpm-workspace-state-v1.json"

cat >"$stage_dir/runtime.json" <<EOF
{
  "schemaVersion": 1,
  "runtimeId": "$runtime_id",
  "platform": "linux",
  "arch": "x64",
  "nodeVersion": "$node_version",
  "pnpmVersion": "$pnpm_version",
  "dshVersion": "$dsh_version"
}
EOF

"$stage_dir/bin/node" "$stage_dir/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" --version >/dev/null
if grep -R -I -q -- "$HOME/" "$stage_dir" || grep -R -I -q -- "$work_dir" "$stage_dir"; then
  echo 'embedded runtime contains a build-machine absolute path' >&2
  exit 1
fi

echo 'Creating deterministic embedded runtime archive'
export LC_ALL=C TZ=UTC
tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner \
  --format=gnu -C "$stage_dir" -cf - . | gzip -n -9 >"$archive_tmp"
tar -tzf "$archive_tmp" >/dev/null
archive_verify_dir="$work_dir/archive-verify"
mkdir -p "$archive_verify_dir"
tar -xzf "$archive_tmp" -C "$archive_verify_dir"
[[ $("$archive_verify_dir/bin/node" --version) == "v$node_version" ]]
[[ $("$archive_verify_dir/bin/node" \
  "$archive_verify_dir/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" --version) == "$dsh_version" ]]

archive_sha256=$(sha256sum "$archive_tmp" | awk '{print $1}')
archive_size=$(stat -c '%s' "$archive_tmp")
cat >"$manifest_tmp" <<EOF
{
  "schemaVersion": 1,
  "runtimeId": "$runtime_id",
  "platform": "linux",
  "arch": "x64",
  "nodeVersion": "$node_version",
  "pnpmVersion": "$pnpm_version",
  "dshVersion": "$dsh_version",
  "archiveName": "$archive_name",
  "archiveSize": $archive_size,
  "archiveSha256": "$archive_sha256"
}
EOF

mv -f -- "$archive_tmp" "$runtime_dir/$archive_name"
mv -f -- "$manifest_tmp" "$runtime_dir/manifest.json"
echo "Embedded runtime created: $runtime_dir/$archive_name ($archive_size bytes)"

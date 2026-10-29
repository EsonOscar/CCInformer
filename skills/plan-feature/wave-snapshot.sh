#!/usr/bin/env bash
# Lists exactly which files changed during a build wave, also in files that already had uncommitted
# changes before it: a git hash of every tracked and untracked (not ignored) file.
# Read-only: it writes nothing to git, the index or the working tree.
#   bash wave-snapshot.sh <out-file>          # before the wave; run anywhere inside the repo
#   bash wave-snapshot.sh --changed <file>    # later: the paths changed, added or removed since <file>
set -eu

usage='usage: wave-snapshot.sh <out-file> | --changed <snapshot-file>'

snapshot() {
  local out=$1 root
  root=$(git rev-parse --show-toplevel)
  (
    cd "$root"
    git -c core.quotePath=false ls-files -co --exclude-standard |
      while IFS= read -r p; do
        if [ -f "$p" ]; then printf '%s\n' "$p"; fi  # a deleted tracked file is still listed
      done | sort -u > "$out.paths"
    git hash-object --stdin-paths < "$out.paths" | paste - "$out.paths" > "$out"
  )
  rm -f "$out.paths"
}

absolute() {
  printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"
}

if [ "${1:-}" = "--changed" ]; then
  before=$(absolute "${2:?$usage}")
  [ -f "$before" ] || { printf 'no snapshot at %s\n' "$before" >&2; exit 2; }
  now=$(mktemp)
  trap 'rm -f "$now" "$now.paths"' EXIT
  snapshot "$now"
  diff "$before" "$now" | awk -F'\t' '/^[<>] /{print $2}' | sort -u
  exit 0
fi

snapshot "$(absolute "${1:?$usage}")"

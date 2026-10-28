#!/usr/bin/env sh
# The mod runs commands in one place only: hooks/register.tsx builds the exec lanes (hooks/core/lanes.ts) from a
# single $.process.run call, and everything else runs commands through a lane, so the lanes' limits hold. This
# fails when another call to $.process.run or $.process.spawn appears under hooks/. A tripwire, not a proof: it
# matches the text of the call. CI and the pre-push hook run it.

root="$(git rev-parse --show-toplevel)"
cd "$root" || exit 2

calls="$(grep -rnE --include='*.ts' --include='*.tsx' '\$\.process\.(run|spawn)\(' hooks)"
outside="$(printf '%s\n' "$calls" | grep -v '^hooks/register\.tsx:' | grep .)"
count="$(printf '%s\n' "$calls" | grep -c '^hooks/register\.tsx:')"

if [ -n "$outside" ] || [ "$count" -ne 1 ]; then
  echo "check-exec: commands run only through the lanes; hooks/register.tsx makes the one \$.process.run call. Found:" >&2
  printf '%s\n' "$calls" | grep . >&2
  exit 1
fi

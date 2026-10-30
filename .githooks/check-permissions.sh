#!/usr/bin/env sh
# What CCInformer does by itself checks its Debug › Settings switch first (hooks/core/permissions.ts). This fails when:
#   - a permission has no gate: no may('<id>') outside the views and the registry (the band's isAllowed(..., '<id>') in
#     hooks/register.tsx counts too);
#   - a gate names an id the registry doesn't have (the checks don't typecheck, so a typo would pass silently);
#   - an effect call (a toast, notification, status, question, pane opening, prompt, message, agent, file write, command,
#     a notify dep, the trust question, or context for Claude) has no may( or isAllowed( on its line or the 3 before it,
#     and no tag saying why: `// asked` (the person started it), `// relay` (a pass-through whose callers are checked)
#     or `// may: <id>` (gated further up; the id must exist).
# A line that starts with `.` continues the one before. A tripwire, not a proof: it matches text. The polls in the
# background are held by tests/passive.test.tsx instead. CI and the pre-push hook run it.

root="$(git rev-parse --show-toplevel)"
cd "$root" || exit 2

registry=hooks/core/permissions.ts
ids="$(awk "match(\$0, /id: '[a-z]+\\.[A-Za-z]+'/) { s = substr(\$0, RSTART + 5, RLENGTH - 6); print s }" "$registry")"
if [ -z "$ids" ]; then
  echo "check-permissions: no permission ids found in $registry" >&2
  exit 2
fi
files="$(find hooks -name '*.ts' -o -name '*.tsx' | grep -v "^$registry\$" | sort)"

status=0
for id in $ids; do
  gated="$(printf '%s\n' "$files" | grep -v '^hooks/view-' | xargs grep -lF "may('$id')")"
  band="$(grep -lF "isAllowed(await read(\$, permissionsAtom), '$id')" hooks/register.tsx)"
  if [ -z "$gated" ] && [ -z "$band" ]; then
    echo "check-permissions: $id has no may('$id') gate outside the views" >&2
    status=1
  fi
done

# Ids named in a gate, a view's isAllowed or a tag, against the registry.
named="$(printf '%s\n' "$files" | xargs awk '
  { line = $0
    while (match(line, /(may|isAllowed)\([^)]*'"'"'[a-z]+\.[A-Za-z]+'"'"'/)) {
      part = substr(line, RSTART, RLENGTH); line = substr(line, RSTART + RLENGTH)
      match(part, /'"'"'[a-z]+\.[A-Za-z]+'"'"'/); print FILENAME ":" FNR " " substr(part, RSTART + 1, RLENGTH - 2)
    }
    if (match($0, /\/\/ may: [a-z]+\.[A-Za-z]+/)) print FILENAME ":" FNR " " substr($0, RSTART + 8, RLENGTH - 8)
  }')"
unknown="$(printf '%s\n' "$named" | grep . | while read -r where id; do
  printf '%s\n' "$ids" | grep -qxF "$id" || echo "$where names $id, which isn't in $registry"
done)"
if [ -n "$unknown" ]; then
  echo "check-permissions: unknown permission ids:" >&2
  printf '%s\n' "$unknown" >&2
  status=1
fi

# Effect calls without a gate or a tag.
# A file's lines are joined as they come, and judged once the file is read (portable awk: no ENDFILE).
ungated="$(printf '%s\n' "$files" | xargs awk '
  function judge(   i, j, ok, line) {
    for (i = 1; i <= n; i++) {
      line = joined[i]
      if (line !~ /\$\.ui\.(toast|notify|status|ask|open)\(|\$\.prompt\.(submit|fill)\(|\$\.session\.send\(|\$\.agent\.spawn\(|\$\.fs\.write\(|\$\.command\.run\(|deps\.notify\(|askTrust\(|context: \[/) continue
      if (line ~ /function askTrust\(/) continue
      if (line ~ /\/\/ (asked|relay|may: [a-z]+\.[A-Za-z]+)/) continue
      ok = 0
      for (j = i; j >= i - 3 && j >= 1; j--) if (joined[j] ~ /may\(|isAllowed\(/) ok = 1
      if (!ok) print file ":" at[i] ": " line
    }
    n = 0
  }
  FNR == 1 { if (n > 0) judge(); file = FILENAME }
  {
    text = $0
    if (n > 0 && text ~ /^[ \t]*\./) { sub(/^[ \t]+/, "", text); joined[n] = joined[n] text; next }
    n++; joined[n] = text; at[n] = FNR
  }
  END { if (n > 0) judge() }
')"
if [ -n "$ungated" ]; then
  echo "check-permissions: these act without a Settings gate; check may(<id>) first, or tag the line (// asked, // relay, // may: <id>):" >&2
  printf '%s\n' "$ungated" >&2
  status=1
fi

exit $status

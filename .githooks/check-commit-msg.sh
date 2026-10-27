#!/usr/bin/env bash
# Checks one PR title (or commit message): type(scope): subject. The type comes from TYPES below;
# the scope is any lowercase word naming the area changed, so there's no list to keep up to date.
# Used by the pr-title job in CI. No dependencies beyond bash and grep.
#
#   bash .githooks/check-commit-msg.sh <file>     check the first line of a file
#   printf '%s\n' "$TITLE" | bash .githooks/check-commit-msg.sh -

TYPES='build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test'
SCOPE='[a-z][a-z0-9-]*'
MAX_HEADER=100

source="${1:--}"
if [ "$source" = - ]; then
  header=$(head -n 1)
else
  header=$(head -n 1 "$source")
fi
header="${header%$'\r'}"

# Messages git writes itself, and fixups that get squashed away before merge.
case "$header" in
  'Merge '* | 'Revert "'* | 'fixup! '* | 'squash! '* | 'amend! '*) exit 0 ;;
esac

fail() {
  echo "✘ $1" >&2
  echo "  got:      $header" >&2
  echo "  expected: type(scope): subject   e.g. feat(git): show the PR's review state" >&2
  echo "  types:    ${TYPES//|/ }" >&2
  echo "  scope:    one lowercase word for the area changed (git, debug, pane, plugin, install, repo...)" >&2
  exit 1
}

[ -n "$header" ] || fail "Empty message."
[ "${#header}" -le "$MAX_HEADER" ] || fail "Header is ${#header} characters; the limit is $MAX_HEADER. Put detail in the body."
printf '%s' "$header" | grep -qE "^($TYPES)[(!:]" || fail "Missing or unknown type."
printf '%s' "$header" | grep -qE "^($TYPES)\($SCOPE\)!?: " || fail "Missing scope (one lowercase word), or no ': ' after it."
printf '%s' "$header" | grep -qE "^[^:]+: [^ ](.*[^.])?$" || fail "Empty subject, or it ends with a period."
exit 0

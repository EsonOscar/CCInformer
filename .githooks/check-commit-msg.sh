#!/usr/bin/env bash
# Checks one commit message or PR title: type(scope): subject, with the scope from SCOPES below.
# Used by .githooks/commit-msg locally and by the pr-title job in CI, so both agree. No dependencies
# beyond bash and grep.
#
#   bash .githooks/check-commit-msg.sh <file>     check the first line of a file
#   printf '%s\n' "$TITLE" | bash .githooks/check-commit-msg.sh -
#
# Missing a scope? Add it here in a PR, and to the list in CONTRIBUTING.md.

TYPES='build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test'
SCOPES='pane|git|agents|sessions|debug|stats|plugin|install|repo|deps|release'
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
  echo "  scopes:   ${SCOPES//|/ }" >&2
  exit 1
}

[ -n "$header" ] || fail "Empty message."
[ "${#header}" -le "$MAX_HEADER" ] || fail "Header is ${#header} characters; the limit is $MAX_HEADER. Put detail in the body."
printf '%s' "$header" | grep -qE "^($TYPES)[(!:]" || fail "Missing or unknown type."
printf '%s' "$header" | grep -qE "^($TYPES)\(($SCOPES)\)!?: " || fail "Missing or unknown scope, or no ': ' after it."
printf '%s' "$header" | grep -qE "^[^:]+: [^ ](.*[^.])?$" || fail "Empty subject, or it ends with a period."
exit 0

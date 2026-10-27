#!/usr/bin/env sh
# The leak guard: checks text for entries of a private denylist (names, hostnames, paths that must never be
# published). The denylist lives outside the repo, one word or phrase per line (blank lines and # comments are
# skipped), and this clone finds it through a local git config key, so no tracked file names it:
#
#   git config ccinformer.denylist <path to your denylist>
#
# A match ignores case and stands as a whole word: no letter or digit touches it on a side where the entry
# itself ends in a letter or digit (so `kit` misses "toolkit", while `.corp.example` still hits
# "db.corp.example"). A line starting with ! names a public string that never counts, such as a GitHub
# handle that contains a denied name: `!<handle>`.
#
# Exit 1 on a match, naming the entry and the line; exit 0 when clean, or with a notice when the key isn't
# set; exit 2 when the key names a file that can't be read. The pre-commit and pre-push hooks run it; run it
# yourself on a PR's title and body before opening the PR:
#
#   sh .githooks/check-text.sh <file>...
#   printf '%s\n' "$TITLE" | sh .githooks/check-text.sh -

denylist="$(git config --get ccinformer.denylist)"
if [ -z "$denylist" ]; then
  echo "leak guard: ccinformer.denylist isn't set in this clone, so nothing was checked (see CONTRIBUTING.md)." >&2
  exit 0
fi
if [ ! -r "$denylist" ]; then
  echo "leak guard: ccinformer.denylist names $denylist, which can't be read." >&2
  exit 2
fi

[ "$#" -gt 0 ] || set -- -

# awk rather than grep: Git for Windows' grep aborts on -i -F -f. The path goes in through the environment, since
# awk -v would read the backslashes of a Windows path as escapes.
LEAK_GUARD_LIST="$denylist" awk '
  function isWordChar(c) { return c ~ /[a-z0-9]/ }

  # Whether key occurs in text with no letter or digit against an edge of key that is itself a letter or digit.
  function holds(text, key,    from, at, before, after) {
    from = 1
    while ((at = index(substr(text, from), key)) > 0) {
      at += from - 1
      before = at > 1 ? substr(text, at - 1, 1) : ""   # some awks read substr(s, 0, 1) as the first character
      after = substr(text, at + length(key), 1)
      if (!(isWordChar(substr(key, 1, 1)) && isWordChar(before)) && \
          !(isWordChar(substr(key, length(key), 1)) && isWordChar(after))) return 1
      from = at + 1
    }
    return 0
  }

  BEGIN {
    list = ENVIRON["LEAK_GUARD_LIST"]
    while ((getline entry < list) > 0) {
      sub(/\r$/, "", entry); sub(/^[ \t]+/, "", entry); sub(/[ \t]+$/, "", entry)
      if (entry == "" || substr(entry, 1, 1) == "#") continue
      if (substr(entry, 1, 1) == "!") {
        allowed = substr(entry, 2); sub(/^[ \t]+/, "", allowed)
        if (allowed != "") allows[tolower(allowed)] = 1
      } else entries[tolower(entry)] = entry
    }
    close(list)
  }

  {
    text = tolower($0)
    sub(/\r$/, "", text)
    # A public string is replaced by a space first, so what stood either side of it stays apart.
    for (allowed in allows)
      while ((at = index(text, allowed)) > 0)
        text = substr(text, 1, at - 1) " " substr(text, at + length(allowed))
    for (key in entries) if (holds(text, key)) {
      source = FILENAME == "-" ? "stdin" : FILENAME
      line = $0; sub(/\r$/, "", line)
      if (length(line) > 160) line = substr(line, 1, 160) "..."
      printf "leak guard: %s:%d holds \"%s\": %s\n", source, FNR, entries[key], line
      found = 1
    }
  }

  END { exit found ? 1 : 0 }
' "$@"

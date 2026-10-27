#!/usr/bin/env bash
# Installs CCInformer from its GitHub marketplace and switches on auto-update for that marketplace.
# Safe to run again: it skips what is already there and updates the mod if it is installed.
#
#   curl -fsSL https://raw.githubusercontent.com/EsonOscar/CCInformer/main/install/install.sh | bash
#
# Set CLAUDE_BIN first when the first `claude` on PATH doesn't run.

set -euo pipefail
repo='EsonOscar/CCInformer'
marketplace='ccinformer'
plugin='ccinformer'

step() { printf '==> %s\n' "$1"; }
die() { printf 'Error: %s\n' "$1" >&2; exit 1; }

# 1. A claude that runs.
claude=''
for candidate in "${CLAUDE_BIN:-}" claude "$HOME/.local/bin/claude"; do
  [ -n "$candidate" ] || continue
  if "$candidate" --version > /dev/null 2>&1; then claude="$candidate"; break; fi
done
[ -n "$claude" ] || die "Claude Code doesn't run here. Install it, or set CLAUDE_BIN to a working claude, and run this again."
step "Using $claude ($("$claude" --version))"

# 2. The marketplace.
if "$claude" plugin marketplace list --json | grep -Eq "\"name\": *\"$marketplace\""; then
  step "Marketplace $marketplace is already added; refreshing it"
  "$claude" plugin marketplace update "$marketplace" || die "Refreshing the marketplace failed."
else
  step "Adding the marketplace $repo"
  "$claude" plugin marketplace add "$repo" || die "Adding the marketplace failed."
fi

# 3. Auto-update on, and no old local copy loaded beside the installed one. Node writes settings.json
#    the way Claude Code does (2-space JSON), so nothing else in the file changes; a backup is kept.
if command -v node > /dev/null 2>&1; then
  step "Switching on auto-update"
  node - <<'EOF' || die "Updating settings.json failed; nothing was written."
const fs = require('fs'), path = require('path'), os = require('os')
const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')
const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}\n'
const s = JSON.parse(text)
const changes = []
const markets = (s.extraKnownMarketplaces ??= {})
const entry = markets.ccinformer ?? { source: { source: 'github', repo: 'EsonOscar/CCInformer' } }
if (entry.autoUpdate !== true) { markets.ccinformer = { ...entry, autoUpdate: true }; changes.push('auto-update on for the ccinformer marketplace') }
const dirs = s.env && s.env.CLAUDE_CODE_PLUGIN_DIRS
if (typeof dirs === 'string') {
  const keep = dirs.split(path.delimiter).filter(d => {
    try {
      const manifest = path.join(d.replace(/^~/, os.homedir()), '.claude-plugin', 'plugin.json')
      const name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name
      if (name === 'ccinformer' || name === 'sidepanel') { changes.push('stopped loading the local copy at ' + d); return false }
    } catch {}
    return true
  })
  if (keep.length === 0) { delete s.env.CLAUDE_CODE_PLUGIN_DIRS; if (Object.keys(s.env).length === 0) delete s.env }
  else s.env.CLAUDE_CODE_PLUGIN_DIRS = keep.join(path.delimiter)
}
if (changes.length) {
  fs.writeFileSync(file + '.bak-ccinformer', text)
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
  for (const c of changes) console.log('settings.json: ' + c)
  console.log('settings.json: the previous version is at ' + file + '.bak-ccinformer')
} else console.log('settings.json: already set')
EOF
else
  printf "Warning: Node isn't installed, so auto-update isn't switched on. In a Claude Code session: /plugin, Marketplaces, %s, Enable auto-update.\n" "$marketplace" >&2
fi
if [ -n "${CLAUDE_CODE_PLUGIN_DIRS:-}" ]; then
  printf 'Warning: CLAUDE_CODE_PLUGIN_DIRS is set in this shell (%s). If it names an old copy of the mod, remove it from your profile.\n' "$CLAUDE_CODE_PLUGIN_DIRS" >&2
fi

# 4. The mod.
if "$claude" plugin list --json | grep -Eq "\"id\": *\"$plugin@$marketplace\""; then
  step "Updating $plugin"
  "$claude" plugin update "$plugin@$marketplace" || die "Updating the mod failed."
else
  step "Installing $plugin"
  "$claude" plugin install "$plugin@$marketplace" --scope user || die "Installing the mod failed."
fi

step "Done. Start a new Claude Code session (or run /reload-plugins in an open one) and type /side."

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

# 2. The tools the mod uses (README "Requirements"): git, then gh and Node, which are optional. A missing one is
#    offered, one at a time, through the package manager found here, and installed only on a yes. Piped into bash,
#    this script's input is the script itself, so the question is asked on the terminal; with no terminal, the
#    commands are only shown.
can_ask=false
if { : < /dev/tty; } 2> /dev/null; then can_ask=true; fi
ask() {
  $can_ask || return 1
  printf '%s [y/N] ' "$1" > /dev/tty
  read -r answer < /dev/tty || return 1
  case "$answer" in y | Y | yes | Yes) return 0 ;; *) return 1 ;; esac
}
pm=''
for candidate in brew apt-get dnf pacman; do
  if command -v "$candidate" > /dev/null 2>&1; then pm="$candidate"; break; fi
done
install_command() {
  local package="$1"
  case "$pm:$1" in
    brew:*) ;;
    pacman:gh) package='github-cli' ;;
    *:node) package='nodejs' ;;
  esac
  case "$pm" in
    brew) printf 'brew install %s' "$package" ;;
    apt-get) printf 'sudo apt-get update && sudo apt-get install -y %s' "$package" ;;
    dnf) printf 'sudo dnf install -y %s' "$package" ;;
    pacman) printf 'sudo pacman -S --needed --noconfirm %s' "$package" ;;
  esac
}
for tool in git node gh; do
  command -v "$tool" > /dev/null 2>&1 && continue
  case "$tool" in
    git) why='adding the marketplace and Code > Git (needed)' ;;
    node) why="switching on auto-update below, and a repo's own tools" ;;
    gh) why='CI in Code > Git, budget readings from CI, merged-PR warnings in Work > Plans' ;;
  esac
  step "$tool isn't installed. It's used for $why."
  if [ -z "$pm" ]; then printf '    No package manager found here (brew, apt-get, dnf, pacman); install %s from its website.\n' "$tool"; continue; fi
  cmd=$(install_command "$tool")
  if ask "    Install it now with: $cmd ?"; then
    sh -c "$cmd" < /dev/tty || printf "Warning: %s couldn't be installed; carrying on without it.\n" "$tool" >&2
  else
    printf '    To install it later: %s\n' "$cmd"
  fi
done
if command -v gh > /dev/null 2>&1 && ! gh auth status > /dev/null 2>&1; then
  if ask "gh isn't logged in to GitHub. Log in now (gh auth login)?"; then
    gh auth login < /dev/tty || printf "Warning: gh couldn't log in; run gh auth login later.\n" >&2
  else
    printf "    gh isn't logged in to GitHub; to log in later: gh auth login\n"
  fi
fi
command -v git > /dev/null 2>&1 || die "git is needed to add the marketplace. Install it, and run this again."

# 3. The marketplace.
if "$claude" plugin marketplace list --json | grep -Eq "\"name\": *\"$marketplace\""; then
  step "Marketplace $marketplace is already added; refreshing it"
  "$claude" plugin marketplace update "$marketplace" || die "Refreshing the marketplace failed."
else
  step "Adding the marketplace $repo"
  "$claude" plugin marketplace add "$repo" || die "Adding the marketplace failed."
fi

# 4. Auto-update on, and no local copy of the mod overriding the installed one. Node (16 or later) writes
#    settings.json the way Claude Code does (2-space JSON), so nothing else in the file changes; a backup is kept.
node_major=0
if command -v node > /dev/null 2>&1; then node_major=$(node -p 'process.versions.node.split(".")[0]' 2> /dev/null || echo 0); fi
if [ "$node_major" -ge 16 ] 2> /dev/null; then
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
// A copy of the mod named in CLAUDE_CODE_PLUGIN_DIRS overrides the installed one. A deleted copy is known by its
// folder's name alone; any other folder that no longer exists is someone else's to remove.
const full = d => d.replace(/^~/, os.homedir())
const isModCopy = d => {
  if (!d.trim()) return false
  try { return ['ccinformer', 'sidepanel'].includes(JSON.parse(fs.readFileSync(path.join(full(d), '.claude-plugin', 'plugin.json'), 'utf8')).name) }
  catch { return !fs.existsSync(full(d)) && /^(ccinformer|sidepanel)$/i.test(path.basename(full(d))) }
}
const dirs = s.env && s.env.CLAUDE_CODE_PLUGIN_DIRS
const removed = []
if (typeof dirs === 'string') {
  const keep = dirs.split(path.delimiter).filter(d => {
    if (isModCopy(d)) { removed.push(d); changes.push('stopped loading the local copy at ' + d); return false }
    if (d && !fs.existsSync(full(d))) console.log('settings.json: CLAUDE_CODE_PLUGIN_DIRS names ' + d + ', which no longer exists; remove it if nothing needs it')
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
// This shell's own CLAUDE_CODE_PLUGIN_DIRS. Inside a Claude Code session it holds what the session started with,
// settings.json's env block included, so only a copy from nowhere else needs the person to act.
const shellDirs = (process.env.CLAUDE_CODE_PLUGIN_DIRS || '').split(path.delimiter).filter(d => d && isModCopy(d))
for (const d of shellDirs) {
  if (removed.includes(d) || process.env.CLAUDECODE === '1') console.log('This shell still loads ' + d + ' from when it started; new sessions won\'t, unless your shell profile sets CLAUDE_CODE_PLUGIN_DIRS')
  else console.error('Warning: CLAUDE_CODE_PLUGIN_DIRS in this shell names a copy of the mod (' + d + '), which overrides the installed one. Remove it from your shell profile.')
}
EOF
else
  if [ "$node_major" != 0 ]; then why="this Node (v$node_major) is older than 16"; else why="Node isn't installed"; fi
  printf "Warning: auto-update isn't switched on: %s. In a Claude Code session: /plugin, Marketplaces, %s, Enable auto-update.\n" "$why" "$marketplace" >&2
  if [ -n "${CLAUDE_CODE_PLUGIN_DIRS:-}" ]; then
    printf 'Warning: CLAUDE_CODE_PLUGIN_DIRS is set in this shell (%s). A copy of the mod named there overrides the installed one; remove it from settings.json or your shell profile.\n' "$CLAUDE_CODE_PLUGIN_DIRS" >&2
  fi
fi

# 5. The mod.
if "$claude" plugin list --json | grep -Eq "\"id\": *\"$plugin@$marketplace\""; then
  step "Updating $plugin"
  "$claude" plugin update "$plugin@$marketplace" || die "Updating the mod failed."
else
  step "Installing $plugin"
  "$claude" plugin install "$plugin@$marketplace" --scope user || die "Installing the mod failed."
fi

step "Done. Start a new Claude Code session (or run /reload-plugins in an open one) and type /ccinformer (or /side)."

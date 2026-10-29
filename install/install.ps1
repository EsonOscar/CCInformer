# Installs CCInformer from its GitHub marketplace and switches on auto-update for that marketplace.
# Safe to run again: it skips what is already there and updates the mod if it is installed.
#
#   irm https://raw.githubusercontent.com/EsonOscar/CCInformer/main/install/install.ps1 | iex
#
# Set CLAUDE_BIN first when the first `claude` on PATH doesn't run.

$ErrorActionPreference = 'Stop'
$Repo = 'EsonOscar/CCInformer'
$Marketplace = 'ccinformer'
$Plugin = 'ccinformer'

function Step($text) { Write-Host "==> $text" }

# 1. A claude that runs.
$claude = $null
foreach ($candidate in @($env:CLAUDE_BIN, 'claude', (Join-Path $HOME '.local\bin\claude.exe')) | Where-Object { $_ }) {
  try {
    & $candidate --version *> $null
    if ($LASTEXITCODE -eq 0) { $claude = $candidate; break }
  } catch {}
}
if (-not $claude) { throw "Claude Code doesn't run here. Install it, or set CLAUDE_BIN to a working claude, and run this again." }
Step "Using $claude ($(& $claude --version))"

# 2. The tools the mod uses (README "Requirements"): git, then gh and Node, which are optional. A missing one is
#    offered, one at a time, through winget, and installed only on a yes; with no console to ask in, the commands are
#    only shown.
$canAsk = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
function Ask($question) { $canAsk -and ((Read-Host "$question [y/N]") -match '^(y|yes)$') }
$hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
$tools = @(
  @{ Name = 'git'; Id = 'Git.Git'; Why = "adding the marketplace and Code > Git (needed); Git for Windows also brings Git Bash, for plan-feature's build waves" }
  @{ Name = 'node'; Id = 'OpenJS.NodeJS.LTS'; Why = "switching on auto-update below, and a repo's own tools" }
  @{ Name = 'gh'; Id = 'GitHub.cli'; Why = 'CI in Code > Git, budget readings from CI, merged-PR warnings in Work > Plans' }
)
foreach ($tool in $tools) {
  if (Get-Command $tool.Name -ErrorAction SilentlyContinue) { continue }
  Step "$($tool.Name) isn't installed. It's used for $($tool.Why)."
  if (-not $hasWinget) { Write-Host "    winget isn't available here; install $($tool.Name) from its website."; continue }
  $command = "winget install --id $($tool.Id) -e --source winget"
  if (-not (Ask "    Install it now with: $command ?")) { Write-Host "    To install it later: $command"; continue }
  & winget install --id $tool.Id -e --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { Write-Warning "winget couldn't install $($tool.Name) (exit $LASTEXITCODE); carrying on without it." }
  # What winget installed is on the PATH of new consoles; this one reads it again.
  $env:Path += ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
if (Get-Command gh -ErrorAction SilentlyContinue) {
  $isLoggedIn = $false
  try { & gh auth status *> $null; $isLoggedIn = $LASTEXITCODE -eq 0 } catch {}
  if (-not $isLoggedIn) {
    if (Ask "gh isn't logged in to GitHub. Log in now (gh auth login)?") { & gh auth login }
    else { Write-Host "    gh isn't logged in to GitHub; to log in later: gh auth login" }
  }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is needed to add the marketplace. Install it, and run this again." }

# 3. The marketplace.
$markets = (& $claude plugin marketplace list --json) -join "`n"
if ($markets -match "`"name`":\s*`"$Marketplace`"") {
  Step "Marketplace $Marketplace is already added; refreshing it"
  & $claude plugin marketplace update $Marketplace
} else {
  Step "Adding the marketplace $Repo"
  & $claude plugin marketplace add $Repo
}
if ($LASTEXITCODE -ne 0) { throw "The marketplace step failed (exit $LASTEXITCODE)." }

# 4. Auto-update on, and no local copy of the mod overriding the installed one. Node (16 or later) writes
#    settings.json the way Claude Code does (2-space JSON), so nothing else in the file changes; a backup is kept.
$settingsScript = @'
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
'@
$nodeMajor = 0
if (Get-Command node -ErrorAction SilentlyContinue) { try { $nodeMajor = [int](& node -p "process.versions.node.split('.')[0]") } catch {} }
if ($nodeMajor -ge 16) {
  Step "Switching on auto-update"
  $settingsScript | node -
  if ($LASTEXITCODE -ne 0) { throw "Updating settings.json failed (exit $LASTEXITCODE); nothing was written." }
} else {
  $why = if ($nodeMajor) { "this Node (v$nodeMajor) is older than 16" } else { "Node isn't installed" }
  Write-Warning "Auto-update isn't switched on: $why. In a Claude Code session: /plugin, Marketplaces, $Marketplace, Enable auto-update."
  if ($env:CLAUDE_CODE_PLUGIN_DIRS) {
    Write-Warning "CLAUDE_CODE_PLUGIN_DIRS is set in this shell ($env:CLAUDE_CODE_PLUGIN_DIRS). A copy of the mod named there overrides the installed one; remove it from settings.json or your shell profile."
  }
}

# 5. The mod.
$installed = (& $claude plugin list --json) -join "`n"
if ($installed -match "`"id`":\s*`"$Plugin@$Marketplace`"") {
  Step "Updating $Plugin"
  & $claude plugin update "$Plugin@$Marketplace"
} else {
  Step "Installing $Plugin"
  & $claude plugin install "$Plugin@$Marketplace" --scope user
}
if ($LASTEXITCODE -ne 0) { throw "The install step failed (exit $LASTEXITCODE)." }

Step "Done. Start a new Claude Code session (or run /reload-plugins in an open one) and type /ccinformer (or /side)."

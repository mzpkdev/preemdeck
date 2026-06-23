#Requires -Version 5.1
# preemdeck bootstrap (Windows PowerShell port of boot.sh).
# Usage:  irm https://github.com/mzpkdev/preemdeck/raw/HEAD/boot.ps1 | iex
#   or:   .\boot.ps1 [harness] [extra install.py args...]

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Harness = "claude",

    # Everything after the harness is forwarded verbatim to install.py.
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

# Fail loudly, like `set -e`.
$ErrorActionPreference = "Stop"

$Repository = "https://github.com/mzpkdev/preemdeck"

# preemdeck's source lives in its OWN dir, never the harness config dir.
# Harness selects which host to install FOR; it no longer decides the clone location.
$HomeDir = if ($HOME) { $HOME } else { $env:USERPROFILE }
$SourceDirectory = Join-Path $HomeDir ".preemdeck"

# --- preflight: git + a Python interpreter ----------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "      x git not found"
    exit 1
}

# On Windows the interpreter is usually `python`; fall back to `python3`.
$python = $null
foreach ($candidate in @("python", "python3")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { $python = $cmd.Source; break }
}
if (-not $python) {
    Write-Host "      x python not found"
    exit 1
}

# --- uv (non-fatal on failure, mirroring boot.sh) ---------------------------
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "      > installing uv"
    try {
        powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
    } catch {
        Write-Host "      ! uv install failed; continuing"
    }
    # Refresh PATH for this session so uv is visible right away. The Windows
    # installer drops uv in %USERPROFILE%\.local\bin and updates the user PATH.
    $localBin = Join-Path $HomeDir ".local\bin"
    if (Test-Path $localBin) { $env:Path = "$localBin;$env:Path" }
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + $env:Path
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        Write-Host "      ! uv not found after install; dependency bootstrap will be skipped - install uv manually and re-run"
    }
}

# --- re-runnable clone/refresh ----------------------------------------------
# ~/.preemdeck is preemdeck's own source, not user config - refresh it in place
# rather than backing it up. (Full update logic lives in update.py.)
if (Test-Path (Join-Path $SourceDirectory ".git")) {
    git -C $SourceDirectory fetch --depth 1 --quiet origin HEAD
    git -C $SourceDirectory reset --hard --quiet FETCH_HEAD
} else {
    git clone --depth 1 --quiet $Repository $SourceDirectory
}

# --- hand off to the Python installer ---------------------------------------
& $python (Join-Path $SourceDirectory "install.py") $Harness @Rest
exit $LASTEXITCODE

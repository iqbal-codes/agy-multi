# agy-multi installer for Windows (PowerShell)
# Usage:
#   Local:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#   Remote: irm https://raw.githubusercontent.com/iqbal-codes/agy-multi/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:REPO_URL) { $env:REPO_URL } else { "https://github.com/iqbal-codes/agy-multi.git" }
$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { "$HOME\.local\bin" }
$SourceDir = "$HOME\.local\share\agy-multi"

Write-Host "Installing agy-multi (multi-account failover for Antigravity)..." -ForegroundColor Cyan

# 1. Check or install Bun
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    if (Test-Path "$HOME\.bun\bin\bun.exe") {
        $env:PATH = "$HOME\.bun\bin;$env:PATH"
    } else {
        Write-Host "==> Bun not found in PATH. Installing Bun via bun.sh..." -ForegroundColor Yellow
        irm bun.sh/install.ps1 | iex
        $env:PATH = "$HOME\.bun\bin;$env:PATH"
    }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "Bun is required to build/run agy-multi. Please install Bun from https://bun.sh."
}

# 2. Determine work directory
$WorkDir = $null
if (Test-Path "package.json") {
    try {
        $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
        if ($pkg.name -eq "agy-multi") {
            $WorkDir = (Get-Location).Path
        }
    } catch {}
}

if (-not $WorkDir) {
    Write-Host "==> Setting up repository in $SourceDir..." -ForegroundColor Cyan
    if (Test-Path "$SourceDir\.git") {
        git -C "$SourceDir" pull --ff-only
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $SourceDir) | Out-Null
        git clone --depth=1 $RepoUrl $SourceDir
    }
    $WorkDir = $SourceDir
}

Set-Location $WorkDir

# 3. Dependencies
Write-Host "==> Installing dependencies..." -ForegroundColor Cyan
bun install

# 4. Build standalone binaries
Write-Host "==> Compiling standalone single-binary executables..." -ForegroundColor Cyan
bun run build

# 5. Install to target directory
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

if (Test-Path "dist\agy-multi.exe") {
    Copy-Item -Force "dist\agy-multi.exe" "$InstallDir\agy-multi.exe"
} elseif (Test-Path "dist\agy-multi") {
    Copy-Item -Force "dist\agy-multi" "$InstallDir\agy-multi.exe"
}

if (Test-Path "dist\agy-multi-acp.exe") {
    Copy-Item -Force "dist\agy-multi-acp.exe" "$InstallDir\agy-multi-acp.exe"
} elseif (Test-Path "dist\agy-multi-acp") {
    Copy-Item -Force "dist\agy-multi-acp" "$InstallDir\agy-multi-acp.exe"
}

# Also copy CMD helper scripts
Copy-Item -Force "bin\agy-multi.cmd" "$InstallDir\agy-multi.cmd" -ErrorAction SilentlyContinue
Copy-Item -Force "bin\agy-multi-acp.cmd" "$InstallDir\agy-multi-acp.cmd" -ErrorAction SilentlyContinue

# 6. Verify PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    Write-Host "==> Adding $InstallDir to User PATH..." -ForegroundColor Yellow
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    $env:PATH = "$env:PATH;$InstallDir"
}

# 7. Check for agy
if (-not (Get-Command agy -ErrorAction SilentlyContinue) -and -not (Test-Path "$InstallDir\agy.exe") -and -not (Test-Path "$env:LOCALAPPDATA\agy\bin\agy.exe")) {
    Write-Host "==> Official Google Antigravity binary ('agy') was not found." -ForegroundColor Yellow
    Write-Host "==> Installing official Antigravity CLI via https://antigravity.google/cli/install.ps1..." -ForegroundColor Cyan
    try {
        irm https://antigravity.google/cli/install.ps1 | iex
        Write-Host "==> Official Antigravity CLI installed successfully!" -ForegroundColor Green
    } catch {
        Write-Host "warning: Could not automatically install agy. Please install it manually from https://antigravity.google." -ForegroundColor Yellow
    }
}

# 8. Ensure T3 Code & ACP rules exist in ~/.gemini/GEMINI.md
$GeminiDir = Join-Path $HOME ".gemini"
$GeminiMd = Join-Path $GeminiDir "GEMINI.md"
$RulesContent = @"
# T3 Code & Subagent Orchestration Rules

When running inside T3 Code (`T3_ACP_MCP_NODE` is present in the environment or host is T3 Code):
1. **Do not use internal `invoke_subagent` for user-facing multi-agent work.**
   Antigravity's internal `invoke_subagent` runs exclusively within the local Antigravity CLI daemon and does not create child task cards or threads in the T3 Code UI.
2. **Use T3 Code's `delegate_task` via the ACP MCP bridge:**
   ```bash
   ELECTRON_RUN_AS_NODE=1 "`$T3_ACP_MCP_NODE" "`$T3_ACP_MCP_ENTRYPOINT" acp-mcp-call delegate_task '{"task":"<task description>","target":{"providerInstanceId":"antigravity-acp","model":"gemini-3.8-flash"},"mode":"async","clientRequestId":"<unique-id>"}'
   ```
   This spawns a first-class subagent thread directly inside T3 Code, complete with a UI progress card, live status, and a verbatim thread link (`<t3-thread://...>`).
3. **Handle Background Processes & Long Commands Explicitly:**
   - In ACP clients like T3 Code, T3 Code cannot track Antigravity's internal daemon tasks (`manage_task`), and `t3_background_wait` is unsupported for this provider. Furthermore, ACP is turn-based, so Antigravity cannot proactively wake up the client when a background task completes.
   - **For commands expected to finish (builds, tests, linters, scripts):**
     - Always set `WaitMsBeforeAsync: 10000` (the maximum allowed) to avoid premature backgrounding.
     - Never end a turn with a generic "I launched it in background" message if the command was supposed to finish. If a command is backgrounded unexpectedly, check `manage_task(Action='status')` or inspect the task log before returning, or inform the user clearly with the exact log path.
   - **For true background daemons (e.g., dev servers, file watchers, background services):**
     - Explicitly state:
       1. The command running and service/port.
       2. The Antigravity Task ID (e.g., `task-XX`).
       3. The full log file link (`file:///.../task-XX.log`).
       4. How to check or terminate it (`manage_task`).
"@

if (-not (Test-Path $GeminiMd)) {
    New-Item -ItemType Directory -Path $GeminiDir -Force | Out-Null
    Set-Content -Path $GeminiMd -Value $RulesContent
    Write-Host "==> Provisioned T3 Code & ACP orchestration rules in $GeminiMd" -ForegroundColor Cyan
} else {
    $existing = Get-Content -Path $GeminiMd -Raw -ErrorAction SilentlyContinue
    if ($existing -notlike "*T3_ACP_MCP_NODE*") {
        Add-Content -Path $GeminiMd -Value "`n$RulesContent"
        Write-Host "==> Appended T3 Code & ACP orchestration rules to $GeminiMd" -ForegroundColor Cyan
    }
}

Write-Host "`nInstallation complete!" -ForegroundColor Green
Write-Host "Quick start:"
Write-Host "  1. Add an account:      agy-multi profile add <slug>"
Write-Host "  2. List profiles:       agy-multi profile list"
Write-Host "  3. Check quotas:        agy-multi quota"
Write-Host "  4. Check token usage:   agy-multi usage"
Write-Host "  5. Connect ACP host:    agy-multi acp  (or binary: agy-multi-acp)`n"

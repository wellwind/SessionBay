# Native WebView/IPC smoke with no real histories, credentials, or agent launches.
# Requires a built Windows executable and the logged-in CI desktop session.
param([string]$Binary = "$PSScriptRoot/../src-tauri/target/release/sessionbay.exe")
$ErrorActionPreference = 'Stop'
$Binary = (Resolve-Path $Binary).Path
$output = Join-Path $PSScriptRoot '../artifacts/windows-smoke'
New-Item -ItemType Directory -Force $output | Out-Null
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("sessionbay-smoke-" + [guid]::NewGuid())
New-Item -ItemType Directory $temporary | Out-Null
$process = $null
try {
    foreach ($theme in @('dark', 'light')) {
        $state = Join-Path $temporary $theme
        New-Item -ItemType Directory $state | Out-Null
        $shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $settings = @{
            version = 1; theme = $theme; terminalTheme = 'bay'
            fontFamily = 'Consolas, monospace'; fontSize = 14
            defaultAgent = 'codex'; defaultProfileId = 'smoke-shell'
            profiles = @(@{ id = 'smoke-shell'; name = 'PowerShell'; executable = $shell; args = @('-NoLogo'); env = @{} })
            sources = @(); executables = @{}; agentOptions = @{}
            shortcuts = @{}; onboardingComplete = $false
        }
        foreach ($kind in @('codex', 'claude', 'grok', 'antigravity')) {
            $settings.executables[$kind] = Join-Path $state "unavailable-$kind.exe"
            $settings.agentOptions[$kind] = @{ extraArgs = @(); bypassPermissions = $false }
        }
        $settings | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $state 'settings.json')
        $start = [Diagnostics.ProcessStartInfo]::new($Binary)
        $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.Environment['SESSIONBAY_SMOKE'] = '1'
        $start.Environment['SESSIONBAY_SMOKE_APP_DATA'] = $state
        $process = [Diagnostics.Process]::Start($start)
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        # The process stays open after the self-check. Bounded timing avoids leaving
        # a hung WebView behind; output pipes are drained concurrently throughout.
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        $windowSeen = $false
        while ([DateTime]::UtcNow -lt $deadline -and !$process.HasExited) {
            $process.Refresh()
            if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $windowSeen = $true }
            Start-Sleep -Milliseconds 200
        }
        $exitedEarly = $process.HasExited
        if (!$process.HasExited) { $process.Kill($true) }
        $process.WaitForExit()
        $log = $stderr.GetAwaiter().GetResult() + $stdout.GetAwaiter().GetResult()
        $log | Set-Content -Encoding utf8 (Join-Path $output "$theme-app.log")
        if ($exitedEarly -or !$windowSeen) { throw 'Native Windows window did not remain alive.' }
        if ($log -match 'SESSIONBAY_FRONTEND .*"phase":"error"') { throw 'Native frontend reported an error.' }
        foreach ($phase in @('ready', 'interaction')) {
            if ($log -notmatch ('SESSIONBAY_FRONTEND .*"phase":"' + $phase + '"')) {
                throw "Missing native frontend marker: $phase"
            }
        }
        $saved = Get-Content -Raw (Join-Path $state 'settings.json') | ConvertFrom-Json
        if (@($saved.sources).Count -ne 0) { throw 'Smoke unexpectedly added a history source.' }
        $process.Dispose()
        $process = $null
        & $Binary --sessionbay-runtime-broker-stop $state
        if ($LASTEXITCODE -ne 0) { throw "Cannot stop isolated smoke runtime broker." }
    }
    'Native Windows dark/light startup, visible window, DOM interaction, and backend IPC passed with isolated empty sources. Terminal/IME, real CLI resume, and installer execution require separate acceptance.' |
        Set-Content -Encoding utf8 (Join-Path $output 'result.txt')
} finally {
    if ($null -ne $process) {
        if (!$process.HasExited) { $process.Kill($true); $process.WaitForExit() }
        $process.Dispose()
    }
    foreach ($state in Get-ChildItem -Directory $temporary) {
        if (Test-Path (Join-Path $state.FullName "runtime-broker-v1")) {
            & $Binary --sessionbay-runtime-broker-stop $state.FullName
        }
    }
    Remove-Item -Recurse -Force $temporary
}

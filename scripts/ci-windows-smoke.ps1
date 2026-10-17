# Native WebView/IPC smoke with no real histories, credentials, or agent launches.
# Requires a built Windows executable and the logged-in CI desktop session.
param([string]$Binary = "$PSScriptRoot/../src-tauri/target/release/sessionbay.exe")
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-smoke-cleanup.ps1"
$Binary = (Resolve-Path $Binary).Path
$output = Join-Path $PSScriptRoot '../artifacts/windows-smoke'
New-Item -ItemType Directory -Force $output | Out-Null
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("sessionbay-smoke-" + [guid]::NewGuid())
New-Item -ItemType Directory $temporary | Out-Null
$process = $null
$states = [Collections.Generic.List[string]]::new()
$primaryError = ''
try {
    foreach ($theme in @('dark', 'light')) {
        $state = Join-Path $temporary $theme
        New-Item -ItemType Directory $state | Out-Null
        $states.Add($state)
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
        $stdoutPath = Join-Path $output "$theme-stdout.log"
        $stderrPath = Join-Path $output "$theme-stderr.log"
        $process = Start-SessionBaySmokeCapture -Binary $Binary -StdoutPath $stdoutPath -StderrPath $stderrPath `
            -Environment @{ SESSIONBAY_SMOKE = '1'; SESSIONBAY_SMOKE_APP_DATA = $state }
        # The process stays open after the self-check. Bounded timing avoids leaving
        # a hung WebView behind; file capture does not wait for descendant pipe EOF.
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        $windowSeen = $false
        while ([DateTime]::UtcNow -lt $deadline -and !$process.HasExited) {
            $process.Refresh()
            if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $windowSeen = $true }
            foreach ($path in @($stdoutPath, $stderrPath)) {
                if ((Get-Item -LiteralPath $path).Length -gt 1MB) { throw 'Smoke log exceeded the 1 MiB file limit.' }
            }
            Start-Sleep -Milliseconds 200
        }
        $exitedEarly = $process.HasExited
        Stop-SessionBaySmokeWindow -Process $process
        Stop-SessionBaySmokeBroker -Binary $Binary -State $state -LogPath (Join-Path $output "$theme-broker-stop.log")
        $log = Read-SessionBaySmokeFiles -Paths @($stderrPath, $stdoutPath)
        $log | Set-Content -Encoding utf8 (Join-Path $output "$theme-app.log")
        if ($exitedEarly -or !$windowSeen) { throw 'Native Windows window did not remain alive.' }
        Assert-SessionBaySmokeMarkers -Log $log
        $saved = Get-Content -Raw (Join-Path $state 'settings.json') | ConvertFrom-Json
        if (@($saved.sources).Count -ne 0) { throw 'Smoke unexpectedly added a history source.' }
        $process.Dispose()
        $process = $null
    }
} catch {
    $primaryError = $_.Exception.Message
    throw
} finally {
    $closeError = ''
    if ($null -ne $process) {
        try {
            Stop-SessionBaySmokeWindow -Process $process
        } catch {
            $closeError = $_.Exception.Message
        } finally {
            $process.Dispose()
        }
    }
    Clear-SessionBaySmokeState -Binary $Binary -States $states.ToArray() `
        -TemporaryDirectory $temporary -OutputDirectory $output -PriorError (($primaryError, $closeError | Where-Object { $_ }) -join "`n")
}
'Native Windows dark/light startup, visible window, DOM interaction, backend IPC, and awaited broker cleanup passed with isolated empty sources. Terminal/IME, real CLI resume, and installer execution require separate acceptance.' |
    Set-Content -Encoding utf8 (Join-Path $output 'result.txt')

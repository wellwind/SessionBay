# Native WebView/IPC smoke with no real histories, credentials, or agent launches.
# Requires a built Windows executable and the logged-in CI desktop session.
param([string]$Binary = "$PSScriptRoot/../src-tauri/target/release/sessionbay.exe", [switch]$Terminal, [switch]$Files)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-smoke-cleanup.ps1"
$Binary = (Resolve-Path $Binary).Path
$output = Join-Path $PSScriptRoot '../artifacts/windows-smoke'
New-Item -ItemType Directory -Force $output | Out-Null
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("sessionbay-smoke-" + [guid]::NewGuid())
$temporary = [IO.Path]::GetFullPath($temporary)
if (![IO.Path]::GetDirectoryName($temporary).Equals([IO.Path]::GetTempPath().TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($temporary) -notmatch '^sessionbay-smoke-[0-9a-f-]{36}$') { throw 'Invalid isolated smoke directory.' }
New-Item -ItemType Directory $temporary | Out-Null
$process = $null
$states = [Collections.Generic.List[string]]::new()
$primaryError = ''
try {
    foreach ($theme in @('dark', 'light')) {
        $state = Join-Path $temporary $theme
        New-Item -ItemType Directory $state | Out-Null
        $states.Add($state)
        $fixture = Join-Path $state 'workspace-fixture'
        $beforeHashes = @()
        if ($Files) {
            New-Item -ItemType Directory $fixture | Out-Null
            [IO.File]::WriteAllText((Join-Path $fixture 'hello.txt'), "SESSIONBAY_SYNTHETIC_PREVIEW`n<literal>安全文字</literal>`n", [Text.UTF8Encoding]::new($false))
            [IO.File]::WriteAllBytes((Join-Path $fixture 'binary.bin'), [byte[]]@(0, 1, 2, 255))
            [IO.File]::WriteAllText((Join-Path $fixture 'oversize.txt'), ('x' * (256KB + 1)))
            [IO.File]::WriteAllText((Join-Path $state 'outside.txt'), 'SYNTHETIC_OUTSIDE_MUST_NOT_READ')
            New-Item -ItemType HardLink -Path (Join-Path $fixture 'hardlink.txt') -Target (Join-Path $state 'outside.txt') | Out-Null
            $beforeHashes = @(Get-ChildItem -LiteralPath $fixture -File | Sort-Object Name | Get-FileHash | Select-Object Path, Hash)
            $beforeHashes | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $output "$theme-files-before.json")
        }
        $shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $settings = @{
            version = 1; theme = $theme; terminalTheme = 'bay'
            fontFamily = 'Consolas, monospace'; fontSize = 14
            defaultAgent = 'codex'; defaultProfileId = 'smoke-shell'
            profiles = @(@{ id = 'smoke-shell'; name = 'PowerShell'; executable = $shell; args = @('-NoLogo', '-NoProfile'); env = @{ SESSIONBAY_SMOKE_INPUT_MARKER = (Join-Path $state 'terminal-input.txt'); SESSIONBAY_SMOKE_WORKSPACE = $fixture } })
            sources = @(); executables = @{}; agentOptions = @{}
            shortcuts = @{}; onboardingComplete = $false
        }
        foreach ($kind in @('codex', 'claude', 'grok', 'antigravity', 'opencode')) {
            $settings.executables[$kind] = Join-Path $state "unavailable-$kind.exe"
            $settings.agentOptions[$kind] = @{ extraArgs = @(); bypassPermissions = $false }
        }
        $settings | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $state 'settings.json')
        $stdoutPath = Join-Path $output "$theme-stdout.log"
        $stderrPath = Join-Path $output "$theme-stderr.log"
        $process = Start-SessionBaySmokeCapture -Binary $Binary -StdoutPath $stdoutPath -StderrPath $stderrPath `
            -Environment @{ SESSIONBAY_SMOKE = '1'; SESSIONBAY_SMOKE_APP_DATA = $state; SESSIONBAY_SMOKE_TERMINAL = $(if ($Terminal) { '1' } else { '0' }); SESSIONBAY_SMOKE_FILES = $(if ($Files) { '1' } else { '0' }) }
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
        if ($Files) {
            if ($log -notmatch 'files:list-text-literal-deny-traversal-binary-hardlink-oversize-escape') { throw 'Native file preview smoke did not finish.' }
            $afterHashes = @(Get-ChildItem -LiteralPath $fixture -File | Sort-Object Name | Get-FileHash | Select-Object Path, Hash)
            $afterHashes | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $output "$theme-files-after.json")
            if (($beforeHashes | ConvertTo-Json -Compress) -ne ($afterHashes | ConvertTo-Json -Compress)) { throw 'Read-only fixture changed.' }
        }
        if ($Terminal) {
            if ($log -notmatch 'terminal:launch-input-exit-close') { throw 'Terminal UI lifecycle smoke did not finish.' }
            if ((Get-Content -Raw -LiteralPath (Join-Path $state 'terminal-input.txt')) -ne 'received') {
                throw 'The isolated shell did not execute the input received through xterm.'
            }
        }
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
'Native Windows dark/light startup, visible window, DOM interaction, backend IPC, and awaited broker cleanup passed with isolated empty sources. See terminal-result.txt when -Terminal was requested; IME, real CLI resume, and installer execution require separate acceptance.' |
    Set-Content -Encoding utf8 (Join-Path $output 'result.txt')

if ($Terminal) {
    'Native dark/light PowerShell launch, xterm input, marker verification, exit code 0, automatic pane/record cleanup, and broker cleanup passed.' |
        Set-Content -Encoding utf8 (Join-Path $output 'terminal-result.txt')
}
if ($Files) {
    'Native dark/light file listing and literal UTF-8 preview passed through production IPC; traversal, binary, hardlink and oversize requests were rejected; Escape/focus/terminal identity and unchanged fixture hashes verified. Synthetic data only; no Agent launched.' |
        Set-Content -Encoding utf8 (Join-Path $output 'files-result.txt')
}

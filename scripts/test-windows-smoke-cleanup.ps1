# Run natively on Windows: the fixture deliberately uses the GUI PE subsystem.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-smoke-cleanup.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) ("sessionbay-cleanup-test-" + [guid]::NewGuid())
$output = Join-Path $PSScriptRoot '../artifacts/windows-smoke/cleanup-regression'
New-Item -ItemType Directory -Force $root, $output | Out-Null
$binary = Join-Path $root 'synthetic GUI helper.exe'
$savedExitCode = $global:LASTEXITCODE
$capture = $null
$inherited = Join-Path $root 'inherited output state'
try {
    & rustc --edition 2021 --deny warnings "$PSScriptRoot/fixtures/smoke-cleanup-child.rs" -o $binary
    if ($LASTEXITCODE -ne 0) { throw 'Cannot build the GUI-subsystem cleanup fixture.' }

    New-Item -ItemType Directory $inherited | Out-Null
    [IO.File]::WriteAllText((Join-Path $inherited 'mode'), 'inherited-output')
    $stdoutPath = Join-Path $output 'inherited-stdout.log'
    $stderrPath = Join-Path $output 'inherited-stderr.log'
    $capture = Start-SessionBaySmokeCapture -Binary $binary -StdoutPath $stdoutPath -StderrPath $stderrPath `
        -Environment @{ SESSIONBAY_SMOKE_APP_DATA = $inherited }
    if (!$capture.WaitForExit(5000)) { throw 'Synthetic UI did not exit.' }
    Stop-SessionBaySmokeWindow -Process $capture
    if (!(Test-Path -LiteralPath (Join-Path $inherited 'holder-started')) -or
        (Test-Path -LiteralPath (Join-Path $inherited 'holder-completed'))) {
        throw 'Synthetic descendant did not retain output after UI exit.'
    }
    # Reading the complete UI output must not require killing the surviving child.
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $log = Read-SessionBaySmokeFiles -Paths @($stderrPath, $stdoutPath)
    Assert-SessionBaySmokeMarkers -Log $log
    if ($timer.Elapsed.TotalSeconds -gt 2) { throw 'File capture waited for descendant EOF.' }
    if (Test-Path -LiteralPath (Join-Path $inherited 'holder-completed')) {
        throw 'Reading UI logs unexpectedly stopped the surviving descendant.'
    }
    foreach ($invalid in @('SESSIONBAY_FRONTEND {"phase":"ready"}', ($log + "`nSESSIONBAY_FRONTEND {`"phase`":`"error`"}"))) {
        $rejected = $false
        try { Assert-SessionBaySmokeMarkers -Log $invalid } catch { $rejected = $true }
        if (!$rejected) { throw 'File capture weakened frontend marker validation.' }
    }
    $oversized = Join-Path $root 'oversized.log'
    $file = [IO.File]::Create($oversized)
    $file.SetLength(1MB + 1)
    $file.Dispose()
    $rejected = $false
    try { Read-SessionBaySmokeFiles -Paths @($oversized) | Out-Null } catch {
        $rejected = $_.Exception.Message -match 'file limit'
    }
    if (!$rejected) { throw 'File capture accepted an oversized log.' }
    Stop-SessionBaySmokeBroker -Binary $binary -State $inherited -LogPath (Join-Path $output 'inherited-stop.log')
    if (!(Test-Path -LiteralPath (Join-Path $inherited 'holder-completed'))) {
        throw 'Explicit fixture cleanup did not release the descendant.'
    }
    $capture.Dispose()
    $capture = $null

    $success = Join-Path $root 'success state with spaces'
    New-Item -ItemType Directory $success | Out-Null
    [IO.File]::WriteAllText((Join-Path $success 'mode'), 'success')
    $global:LASTEXITCODE = 91 # A stale native result must not override this child's success.
    Stop-SessionBaySmokeBroker -Binary $binary -State $success -LogPath (Join-Path $output 'cleanup-success.log')
    if (!(Test-Path -LiteralPath (Join-Path $success 'completed'))) { throw 'Stop returned before the GUI child finished.' }

    $failure = Join-Path $root 'failure state'
    New-Item -ItemType Directory $failure | Out-Null
    [IO.File]::WriteAllText((Join-Path $failure 'mode'), 'failure')
    $global:LASTEXITCODE = 0 # A stale success must not hide the actual nonzero child exit.
    $rejected = $false
    try {
        Clear-SessionBaySmokeState -Binary $binary -States @($failure, $success) `
            -TemporaryDirectory $failure -OutputDirectory $output
    } catch {
        $rejected = $_.Exception.Message -match 'exit 23'
    }
    if (!$rejected -or !(Test-Path -LiteralPath $failure)) { throw 'Failed cleanup must fail and preserve state.' }
    if (!(Test-Path -LiteralPath (Join-Path $output 'success state with spaces-broker-cleanup.log'))) {
        throw 'One failed stop prevented the other isolated state from being cleaned.'
    }

    $primaryFailure = Join-Path $root 'UI assertion failure state'
    New-Item -ItemType Directory $primaryFailure | Out-Null
    [IO.File]::WriteAllText((Join-Path $primaryFailure 'mode'), 'success')
    $rejected = $false
    try {
        Clear-SessionBaySmokeState -Binary $binary -States @($primaryFailure) `
            -TemporaryDirectory $primaryFailure -OutputDirectory $output -PriorError 'synthetic UI assertion failed'
    } catch {
        $rejected = $_.Exception.Message -match 'synthetic UI assertion failed'
    }
    if (!$rejected -or !(Test-Path -LiteralPath (Join-Path $primaryFailure 'completed'))) {
        throw 'A UI assertion failure must still stop its broker and retain diagnostic state.'
    }

    $timeout = Join-Path $root 'timeout state'
    New-Item -ItemType Directory $timeout | Out-Null
    [IO.File]::WriteAllText((Join-Path $timeout 'mode'), 'timeout')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $rejected = $false
    try {
        Clear-SessionBaySmokeState -Binary $binary -States @($timeout) `
            -TemporaryDirectory $timeout -OutputDirectory $output -TimeoutMilliseconds 1000
    } catch {
        $rejected = $_.Exception.Message -match 'timed out'
    }
    if (!$rejected -or $timer.Elapsed.TotalSeconds -gt 10 -or !(Test-Path -LiteralPath $timeout)) {
        throw 'Timeout cleanup must be bounded, fail, and preserve state.'
    }
    if (Test-Path -LiteralPath (Join-Path $timeout 'completed')) { throw 'Timed-out helper unexpectedly completed.' }

    $pendingOutput = [Threading.Tasks.TaskCompletionSource[string]]::new()
    $closedOutput = [Threading.Tasks.TaskCompletionSource[string]]::new()
    $closedOutput.SetResult('')
    $timer.Restart()
    $rejected = $false
    try {
        Read-SessionBaySmokeOutput -Stdout $pendingOutput.Task -Stderr $closedOutput.Task | Out-Null
    } catch {
        $rejected = $_.Exception.Message -match 'output pipes did not close'
    }
    if (!$rejected -or $timer.Elapsed.TotalSeconds -gt 10) { throw 'Inherited output handles bypassed the drain deadline.' }
    $pendingOutput.SetResult('')

    # Actual successful cleanup deletes only after the delayed child has finished.
    Clear-SessionBaySmokeState -Binary $binary -States @($success) `
        -TemporaryDirectory $success -OutputDirectory $output
    if (Test-Path -LiteralPath $success) { throw 'Successful cleanup did not remove its isolated state.' }
    'GUI-subsystem cleanup: inherited-file capture after UI exit, strict markers/log limits, explicit descendant cleanup, awaited completion, exact spaced arguments, actual exit code, process/pipe deadlines, cleanup after UI failure, and diagnostic-state retention passed.' |
        Set-Content -Encoding utf8 -LiteralPath (Join-Path $output 'cleanup-regression-result.txt')
} finally {
    $global:LASTEXITCODE = $savedExitCode
    $captureCloseError = ''
    if ($null -ne $capture) {
        try { Stop-SessionBaySmokeWindow -Process $capture } catch {
            $captureCloseError = $_.Exception.Message
        } finally { $capture.Dispose() }
    }
    if (Test-Path -LiteralPath (Join-Path $inherited 'holder-started')) {
        [IO.File]::WriteAllText((Join-Path $inherited 'release-holder'), 'fixture finally cleanup')
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while (!(Test-Path -LiteralPath (Join-Path $inherited 'holder-completed')) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 20
        }
        if (!(Test-Path -LiteralPath (Join-Path $inherited 'holder-completed'))) {
            throw "Synthetic descendant did not release; preserved $root"
        }
    }
    if ($captureCloseError) { throw "$captureCloseError; preserved $root" }
    Remove-Item -Recurse -Force -LiteralPath $root
}

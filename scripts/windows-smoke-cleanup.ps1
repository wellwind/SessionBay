# Shared by native smoke and its synthetic GUI-subsystem regression tests.
function Read-SessionBaySmokeOutput {
    param(
        [Parameter(Mandatory)][Threading.Tasks.Task]$Stdout,
        [Parameter(Mandatory)][Threading.Tasks.Task]$Stderr
    )
    # A descendant can retain an inherited pipe after its parent exits. Never let
    # output draining bypass the process deadline or prevent authenticated cleanup.
    if (![Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($Stdout, $Stderr), 5000)) {
        throw 'Smoke output pipes did not close within their deadline.'
    }
    return $Stderr.GetAwaiter().GetResult() + $Stdout.GetAwaiter().GetResult()
}

function Stop-SessionBaySmokeWindow {
    param([Parameter(Mandatory)][Diagnostics.Process]$Process)
    if (!$Process.HasExited) {
        [void]$Process.CloseMainWindow()
        if (!$Process.WaitForExit(5000)) {
            # The detached broker must survive UI exit until authenticated cleanup.
            # Never kill the process tree or find processes by a reused PID/name.
            if (!$Process.HasExited) { $Process.Kill() }
            if (!$Process.WaitForExit(5000)) { throw 'Smoke UI did not exit within its deadline.' }
        }
    }
}

function Stop-SessionBaySmokeBroker {
    param(
        [Parameter(Mandatory)][string]$Binary,
        [Parameter(Mandatory)][string]$State,
        [Parameter(Mandatory)][string]$LogPath,
        # Hello (8s), Shutdown (8s), and lock release (5s), plus process startup.
        [ValidateRange(1, 60000)][int]$TimeoutMilliseconds = 30000
    )
    # Release sessionbay.exe is a GUI-subsystem binary. PowerShell's direct '&'
    # invocation backgrounds it and does not reliably set LASTEXITCODE.
    $start = [Diagnostics.ProcessStartInfo]::new($Binary)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.ArgumentList.Add('--sessionbay-runtime-broker-stop')
    $start.ArgumentList.Add($State)
    $stop = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $stop.StandardOutput.ReadToEndAsync()
        $stderr = $stop.StandardError.ReadToEndAsync()
        if (!$stop.WaitForExit($TimeoutMilliseconds)) {
            if (!$stop.HasExited) { $stop.Kill() }
            if (!$stop.WaitForExit(5000)) { throw 'Smoke broker-stop helper did not terminate.' }
            throw 'Isolated smoke broker-stop timed out; state is preserved.'
        }
        $log = Read-SessionBaySmokeOutput -Stdout $stdout -Stderr $stderr
        ("exitCode=$($stop.ExitCode)`n" + $log) | Set-Content -Encoding utf8 -LiteralPath $LogPath
        if ($stop.ExitCode -ne 0) { throw "Cannot stop isolated smoke runtime broker (exit $($stop.ExitCode)); see $LogPath" }
    } finally {
        $stop.Dispose()
    }
}

function Clear-SessionBaySmokeState {
    param(
        [Parameter(Mandatory)][string]$Binary,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$States,
        [Parameter(Mandatory)][string]$TemporaryDirectory,
        [Parameter(Mandatory)][string]$OutputDirectory,
        [string]$PriorError = '',
        [ValidateRange(1, 60000)][int]$TimeoutMilliseconds = 30000
    )
    $failures = [Collections.Generic.List[string]]::new()
    if ($PriorError) { $failures.Add($PriorError) }
    # Try every known isolated state even after a UI assertion or earlier stop fails.
    foreach ($state in $States) {
        try {
            $name = [IO.Path]::GetFileName($state)
            Stop-SessionBaySmokeBroker -Binary $Binary -State $state `
                -LogPath (Join-Path $OutputDirectory "$name-broker-cleanup.log") `
                -TimeoutMilliseconds $TimeoutMilliseconds
        } catch {
            $failures.Add($_.Exception.Message)
        }
    }
    if ($failures.Count -gt 0) {
        $message = "Isolated smoke cleanup failed; preserved $TemporaryDirectory`n" + ($failures -join "`n")
        $message | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutputDirectory 'cleanup-error.txt')
        throw $message
    }
    # Only delete after the owned UI has exited and every broker stop has completed.
    Remove-Item -Recurse -Force -LiteralPath $TemporaryDirectory
}

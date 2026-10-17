# Pure checks: safe to dot-source locally. Environment markers prevent accidental
# use; they are not a security boundary against somebody deliberately spoofing CI.
function Assert-SessionBayInstallerRunner {
    param([hashtable]$Environment, [bool]$Accepted)
    if (!$Accepted) { throw 'Installer smoke requires explicit disposable-runner consent.' }
    $required = @{
        GITHUB_ACTIONS = 'true'; RUNNER_ENVIRONMENT = 'github-hosted'
        RUNNER_OS = 'Windows'; RUNNER_ARCH = 'X64'; ImageOS = 'win22'
        GITHUB_REPOSITORY = 'wellwind/SessionBay'; GITHUB_EVENT_NAME = 'workflow_dispatch'
        SESSIONBAY_INSTALLER_SMOKE = '1'
    }
    foreach ($key in $required.Keys) {
        if ($Environment[$key] -cne $required[$key]) { throw "Installer smoke refuses this environment: $key" }
    }
    if ($Environment.GITHUB_RUN_ID -cnotmatch '^[0-9]+$' -or
        $Environment.SESSIONBAY_SOURCE_SHA -cnotmatch '^[0-9a-f]{40}$') {
        throw 'Installer smoke requires a run ID and immutable source SHA.'
    }
}

function Assert-SessionBayChildPath {
    param([string]$Root, [string]$Path)
    if (![IO.Path]::IsPathFullyQualified($Root) -or ![IO.Path]::IsPathFullyQualified($Path)) {
        throw 'Containment checks require absolute root and child paths.'
    }
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $full = [IO.Path]::GetFullPath($Path)
    if (!$full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the test root: $Path"
    }
    return $full
}

function Resolve-SessionBayContainedFile {
    param([string]$Root, [string]$Path)
    if (![IO.Path]::IsPathFullyQualified($Root)) { throw 'File root must be absolute.' }
    # .NET relative paths use Environment.CurrentDirectory, not Push-Location.
    # Resolve explicitly against the caller's source/install root before any I/O.
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $full = Assert-SessionBayChildPath $rootPath ([IO.Path]::GetFullPath($Path, $rootPath))
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($item.PSIsContainer) { throw "Expected a file: $full" }
    # A lexically contained junction/symlink must not redirect outside the root.
    $ancestor = $item
    while ($true) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point is not allowed: $($ancestor.FullName)" }
        if ($ancestor.FullName.TrimEnd('\', '/') -eq $rootPath) { break }
        $parent = if ($ancestor.PSIsContainer) { $ancestor.Parent.FullName } else { $ancestor.DirectoryName }
        $ancestor = Get-Item -LiteralPath $parent -Force -ErrorAction Stop
    }
    return $full
}

function Get-SessionBayPeMachine {
    param([string]$Path)
    if (![IO.Path]::IsPathFullyQualified($Path)) { throw 'PE inspection requires an explicitly resolved absolute path.' }
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Missing MZ header.' }
        $stream.Position = 0x3c
        $offset = $reader.ReadInt32()
        if ($offset -lt 0x40 -or $offset -gt $stream.Length - 6) { throw 'Invalid PE offset.' }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x4550) { throw 'Missing PE signature.' }
        return $reader.ReadUInt16()
    } finally { $reader.Dispose(); $stream.Dispose() }
}

# NSIS removes INSTDIR before its registration/shortcut cleanup. A single
# deadline must cover all completion signals, not just directory disappearance.
# The injected read-only snapshot permits ordering/timeout tests without installs.
function Wait-SessionBayUninstallCompletion {
    param(
        [Parameter(Mandatory)][scriptblock]$Snapshot,
        [ValidateRange(1, 60000)][int]$TimeoutMilliseconds = 60000,
        [ValidateRange(1, 1000)][int]$PollMilliseconds = 250
    )
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $state = & $Snapshot
        if (!$state.DirectoryExists -and @($state.Registrations).Count -eq 0 -and @($state.Shortcuts).Count -eq 0) {
            return $state
        }
        $remaining = $TimeoutMilliseconds - $clock.ElapsedMilliseconds
        if ($remaining -le 0) {
            $diagnostic = $state | ConvertTo-Json -Depth 6 -Compress
            throw "Uninstall completion timed out after ${TimeoutMilliseconds}ms; last observed state: $diagnostic"
        }
        Start-Sleep -Milliseconds ([int][Math]::Min($PollMilliseconds, $remaining))
    }
}

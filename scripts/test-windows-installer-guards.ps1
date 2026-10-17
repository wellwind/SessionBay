# No installer, registry mutation, or GUI process is invoked by these tests.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-installer-guards.ps1"
function Assert-Rejected {
    param([scriptblock]$Action, [string]$Label)
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    if (!$rejected) { throw "Expected refusal: $Label" }
}
$valid = @{
    GITHUB_ACTIONS = 'true'; RUNNER_ENVIRONMENT = 'github-hosted'; RUNNER_OS = 'Windows'
    RUNNER_ARCH = 'X64'; ImageOS = 'win22'; GITHUB_REPOSITORY = 'wellwind/SessionBay'
    GITHUB_EVENT_NAME = 'workflow_dispatch'; SESSIONBAY_INSTALLER_SMOKE = '1'
    GITHUB_RUN_ID = '123'; SESSIONBAY_SOURCE_SHA = ('a' * 40)
}
Assert-SessionBayInstallerRunner $valid $true
Assert-Rejected { Assert-SessionBayInstallerRunner $valid $false } 'consent absent'
Assert-Rejected { Assert-SessionBayInstallerRunner @{} $true } 'local environment'
foreach ($key in $valid.Keys) {
    $copy = $valid.Clone()
    $copy.Remove($key)
    Assert-Rejected { Assert-SessionBayInstallerRunner $copy $true } "missing $key"
}
foreach ($change in @(
    @{ RUNNER_ENVIRONMENT = 'self-hosted' }, @{ RUNNER_ARCH = 'ARM64' },
    @{ GITHUB_EVENT_NAME = 'push' }, @{ GITHUB_REPOSITORY = 'someone/SessionBay' },
    @{ SESSIONBAY_SOURCE_SHA = 'main' }, @{ SESSIONBAY_SOURCE_SHA = ('a' * 40) + ';echo unsafe' }
)) {
    $copy = $valid.Clone()
    foreach ($key in $change.Keys) { $copy[$key] = $change[$key] }
    Assert-Rejected { Assert-SessionBayInstallerRunner $copy $true } ($change | ConvertTo-Json -Compress)
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('installer-guard-test-' + [guid]::NewGuid())
Assert-Rejected { Assert-SessionBayChildPath $root $root } 'root itself'
Assert-Rejected { Assert-SessionBayChildPath $root ($root + '-sibling') } 'prefix sibling'
Assert-Rejected { Assert-SessionBayChildPath $root (Join-Path $root '../escape') } 'parent traversal'
$child = Assert-SessionBayChildPath $root (Join-Path $root 'payload.exe')
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $bytes = [byte[]]::new(128)
    $bytes[0] = 0x4d; $bytes[1] = 0x5a; $bytes[0x3c] = 0x40
    $bytes[0x40] = 0x50; $bytes[0x41] = 0x45; $bytes[0x44] = 0x64; $bytes[0x45] = 0x86
    [IO.File]::WriteAllBytes($child, $bytes)
    if ((Get-SessionBayPeMachine $child) -ne 0x8664) { throw 'x64 PE parser failed.' }
    $bytes[0x44] = 0x64; $bytes[0x45] = 0xaa
    [IO.File]::WriteAllBytes($child, $bytes)
    if ((Get-SessionBayPeMachine $child) -ne 0xaa64) { throw 'ARM64 PE parser failed.' }
    $bytes[0x40] = 0
    [IO.File]::WriteAllBytes($child, $bytes)
    Assert-Rejected { Get-SessionBayPeMachine $child } 'corrupt PE signature'
} finally {
    # Only the exact synthetic file and now-empty private directory are removed.
    $null = Assert-SessionBayChildPath $root $child
    Remove-Item -LiteralPath $child
    [IO.Directory]::Delete($root, $false)
}
'PASS: explicit opt-in/host/source guards, path containment and synthetic PE headers.'

# Reproduce NSIS ordering: directory disappears, then registration, then shortcuts.
# Delayed polling must not return at the first absent-directory observation.
$sequence = @(
    [pscustomobject]@{ DirectoryExists = $true; Registrations = @('test-registration'); Shortcuts = @('test.lnk') },
    [pscustomobject]@{ DirectoryExists = $false; Registrations = @('test-registration'); Shortcuts = @('test.lnk') },
    [pscustomobject]@{ DirectoryExists = $false; Registrations = @(); Shortcuts = @('test.lnk') },
    [pscustomobject]@{ DirectoryExists = $false; Registrations = @(); Shortcuts = @() }
)
$observations = @{ Count = 0 }
$completion = Wait-SessionBayUninstallCompletion -TimeoutMilliseconds 2000 -PollMilliseconds 5 -Snapshot {
    $index = [Math]::Min($observations.Count, $sequence.Count - 1)
    $observations.Count++
    $sequence[$index]
}
if ($observations.Count -ne 4 -or $completion.DirectoryExists -or @($completion.Registrations).Count -or @($completion.Shortcuts).Count) {
    throw 'Uninstall wait returned before every completion signal cleared.'
}
# Reverse order also requires the directory, not just registry/shortcuts, to clear.
$observations.Count = 0
$null = Wait-SessionBayUninstallCompletion -TimeoutMilliseconds 2000 -PollMilliseconds 5 -Snapshot {
    $observations.Count++
    [pscustomobject]@{ DirectoryExists = ($observations.Count -lt 3); Registrations = @(); Shortcuts = @() }
}
if ($observations.Count -ne 3) { throw 'Uninstall wait ignored delayed directory removal.' }
# Each independently stuck completion signal must time out and retain diagnosis.
foreach ($stuck in @(
    [pscustomobject]@{ DirectoryExists = $true; Registrations = @(); Shortcuts = @() },
    [pscustomobject]@{ DirectoryExists = $false; Registrations = @('stuck-registration'); Shortcuts = @() },
    [pscustomobject]@{ DirectoryExists = $false; Registrations = @(); Shortcuts = @('stuck-shortcut.lnk') }
)) {
    $errorText = ''
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try { $null = Wait-SessionBayUninstallCompletion -TimeoutMilliseconds 30 -PollMilliseconds 5 -Snapshot { $stuck } }
    catch { $errorText = $_.Exception.Message }
    $expected = $stuck | ConvertTo-Json -Depth 6 -Compress
    if (!$errorText.Contains('timed out') -or !$errorText.Contains($expected) -or $clock.ElapsedMilliseconds -gt 2000) {
        throw 'Timeout did not fail within its bound with complete last-observed diagnostics.'
    }
}
'PASS: sequential/delayed uninstall completion and directory/registration/shortcut timeout diagnostics.'

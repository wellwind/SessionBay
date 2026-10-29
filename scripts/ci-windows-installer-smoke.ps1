# Never run this acceptance test on a workstation or self-hosted runner.
[CmdletBinding()]
param([switch]$AcceptDisposableRunner)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-installer-guards.ps1"
$environment = @{}
Get-ChildItem Env: | ForEach-Object { $environment[$_.Name] = $_.Value }
# This must precede all filesystem writes, registry access and process launches.
Assert-SessionBayInstallerRunner -Environment $environment -Accepted $AcceptDisposableRunner.IsPresent
if (!$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This acceptance job requires native Windows x64.'
}
$source = Assert-SessionBayChildPath $env:GITHUB_WORKSPACE (Join-Path $env:GITHUB_WORKSPACE 'source')
$output = Assert-SessionBayChildPath $env:GITHUB_WORKSPACE (Join-Path $env:GITHUB_WORKSPACE 'artifacts/windows-installer')
$testRoot = Assert-SessionBayChildPath $env:RUNNER_TEMP (Join-Path $env:RUNNER_TEMP ("sessionbay-installer-" + [guid]::NewGuid()))
$install = Assert-SessionBayChildPath $testRoot (Join-Path $testRoot 'installed')
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Session Bay'
$productKey = 'Software\sessionbay\Session Bay'
$bundleId = 'dev.fullstackladder.sessionbay'

function Get-ProductRegistration {
    # Enumerate both views/hives to detect NSIS and WiX product collisions.
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            try {
                $root = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
                if ($root) {
                    try {
                        foreach ($name in $root.GetSubKeyNames()) {
                            $key = $root.OpenSubKey($name)
                            if (!$key) { continue }
                            try {
                                if ($name -eq 'Session Bay' -or $key.GetValue('DisplayName') -eq 'Session Bay' -or
                                    $key.GetValue('Publisher') -eq 'sessionbay') {
                                    [pscustomobject]@{ Hive = "$hive"; View = "$view"; Key = $name
                                        Version = $key.GetValue('DisplayVersion'); Location = $key.GetValue('InstallLocation')
                                        Uninstall = $key.GetValue('UninstallString') }
                                }
                            } finally { $key.Dispose() }
                        }
                    } finally { $root.Dispose() }
                }
            } finally { $base.Dispose() }
        }
    }
}

function Assert-NoProductProcesses {
    if (@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -in @('sessionbay', 'sessionbay-broker') }).Count) {
        throw 'SessionBay processes still exist; refusing installer/uninstaller process shutdown.'
    }
}

function Invoke-OwnedExecutable {
    param([string]$Path, [string]$Arguments, [int]$TimeoutSeconds = 120)
    # Raw argument string is intentional: NSIS /D must be last and unquoted.
    # Every argument comes from test-owned paths, never user shell text.
    $start = [Diagnostics.ProcessStartInfo]::new($Path)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.Arguments = $Arguments
    $process = [Diagnostics.Process]::Start($start)
    try {
        if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
            throw 'Installer process timed out; preserve state for disposable runner teardown, do not retry.'
        }
        if ($process.ExitCode -ne 0) { throw "Installer process failed: $($process.ExitCode)" }
        return $process.ExitCode
    } finally { $process.Dispose() }
}

# Refuse pre-existing data, product settings, shortcuts and installation state.
$dataPaths = @([Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData')) |
    ForEach-Object { Join-Path $_ $bundleId }
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Session Bay.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Session Bay.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Session Bay')
)
foreach ($path in @($dataPaths) + $shortcutPaths + @((Join-Path $env:LOCALAPPDATA 'Session Bay'))) {
    if (Test-Path -LiteralPath $path) { throw "Pre-existing product path; refusing test: $path" }
}
if (@(Get-ProductRegistration).Count) { throw 'Pre-existing product registration; refusing test.' }
foreach ($hive in @('HKCU:', 'HKLM:')) {
    foreach ($key in @($productKey, "Software\Classes\AppUserModelId\$bundleId")) {
        if (Test-Path -LiteralPath "$hive\$key") { throw 'Pre-existing product preferences; refusing test.' }
    }
}
if ((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).'Session Bay') {
    throw 'Pre-existing autostart registration; refusing test.'
}
Assert-NoProductProcesses
$webviewKey = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$webview = (Get-ItemProperty "HKLM:\$webviewKey" -ErrorAction SilentlyContinue).pv
if (!$webview) {
    $webview = (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv
}
if (!$webview) { throw 'Preinstalled WebView2 is required; do not bootstrap or change system dependencies.' }

Push-Location $source
try {
    $head = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -cne $env:SESSIONBAY_SOURCE_SHA) { throw 'Source SHA mismatch.' }
    $origin = (git remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or $origin -notmatch '^https://github\.com/wellwind/SessionBay(?:\.git)?$') { throw 'Not the official source checkout.' }
    $dirty = git status --porcelain
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Source checkout must start clean.' }
    if (Test-Path 'src-tauri/target') { throw 'Refusing reused build output.' }
    $config = Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
    $windows = Get-Content 'src-tauri/tauri.windows.conf.json' -Raw | ConvertFrom-Json
    if ($config.productName -cne 'Session Bay' -or $config.identifier -cne $bundleId -or
        $windows.bundle.windows.nsis.installMode -cne 'currentUser') { throw 'Official product/currentUser config mismatch.' }
    New-Item -ItemType Directory -Path $output, $testRoot | Out-Null
    $result = [ordered]@{ sourceSha = $head; harnessSha = $env:GITHUB_SHA; runner = $env:RUNNER_NAME
        runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; installPath = $install
        osVersion = [Environment]::OSVersion.VersionString
        image = $env:ImageVersion; architecture = 'x64'; version = $config.version; scope = 'currentUser'
        webview = $webview; install = 'NOT RUN'; launch = 'NOT RUN'; uninstall = 'NOT RUN'; cleanup = 'NOT RUN'
        shortcutCoverage = '/NS suppresses creation; absence is checked, shortcut creation/removal is NOT RUN.'
        limitation = 'Hosted Windows runs as administrator with UAC disabled; no standard-user, SmartScreen or ARM64 acceptance.' }
    $installed = $false
    $primaryError = $null
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        & npm.cmd run tauri -- build --bundles nsis
        if ($LASTEXITCODE -ne 0) { throw 'Official NSIS build failed.' }
        $dirty = git status --porcelain --untracked-files=no
        if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Build modified tracked source.' }
        if ((git rev-parse HEAD).Trim() -cne $head -or $LASTEXITCODE -ne 0) { throw 'Source HEAD changed during build.' }
        $packages = @(Get-ChildItem 'src-tauri/target/release/bundle/nsis' -Filter '*-setup.exe' -File)
        if ($packages.Count -ne 1) { throw 'Expected exactly one freshly built installer.' }
        $package = $packages[0].FullName
        $nsi = Get-Content 'src-tauri/target/release/nsis/x64/installer.nsi' -Raw
        foreach ($definition in @('!define INSTALLMODE "currentUser"', '!define ARCH "x64"', '!define BUNDLEID "dev.fullstackladder.sessionbay"')) {
            if (!$nsi.Contains($definition)) { throw "Generated NSIS does not match expected product: $definition" }
        }
        if ((Get-SessionBayPeMachine $package) -ne 0x014c) { throw 'Unexpected NSIS loader architecture.' }
        $hashes = @{}
        foreach ($name in @('sessionbay.exe', 'sessionbay-broker.exe')) {
            $binary = Join-Path 'src-tauri/target/release' $name
            if ((Get-SessionBayPeMachine $binary) -ne 0x8664) { throw 'Payload must be native x64.' }
            $hashes[$name] = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
        }
        $result.installerSha256 = (Get-FileHash $package -Algorithm SHA256).Hash
        $result.payloadSha256 = $hashes
        $result.installerVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($package).ProductVersion
        if ($result.installerVersion -ne $config.version) { throw 'Installer version mismatch.' }
        Assert-NoProductProcesses
        $result.install = 'STARTED'
        $result.installExitCode = Invoke-OwnedExecutable $package "/S /NS /D=$install"
        $registrations = @(Get-ProductRegistration)
        if (!$registrations.Count -or @($registrations | Where-Object {
            $_.Hive -ne 'CurrentUser' -or $_.Key -ne 'Session Bay' -or
            $_.Location.Trim('"') -ne $install -or $_.Version -ne $config.version -or
            $_.Uninstall.Trim('"') -ne (Join-Path $install 'uninstall.exe')
        }).Count) { throw 'Uninstall registration is missing or has unexpected scope/path/version.' }
        foreach ($name in $hashes.Keys) {
            $binary = Join-Path $install $name
            if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $hashes[$name] -or
                (Get-SessionBayPeMachine $binary) -ne 0x8664) { throw 'Installed payload mismatch.' }
        }
        if (!(Test-Path -LiteralPath (Join-Path $install 'uninstall.exe') -PathType Leaf)) { throw 'Missing uninstaller.' }
        $result.installedVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $install 'sessionbay.exe')).ProductVersion
        if ($result.installedVersion -ne $config.version) { throw 'Installed executable version mismatch.' }
        $uninstallerHash = (Get-FileHash -LiteralPath (Join-Path $install 'uninstall.exe')).Hash
        $result.uninstallerSha256 = $uninstallerHash
        $installed = $true
        $result.install = 'PASS'
        $result.registration = $registrations
        # Newly created sentinel data proves default uninstall preserves app data.
        $sentinels = @{}
        foreach ($path in $dataPaths) {
            if (Test-Path -LiteralPath $path) { throw 'Unexpected data appeared before first launch.' }
            New-Item -ItemType Directory -Path $path | Out-Null
            $sentinel = Join-Path $path 'installer-smoke-sentinel.txt'
            Set-Content -LiteralPath $sentinel -Value ([guid]::NewGuid().ToString()) -Encoding utf8
            $sentinels[$sentinel] = (Get-FileHash $sentinel).Hash
        }
        $result.launch = 'STARTED'
        # Existing native smoke seeds complete empty-source state, waits for a
        # window and frontend/IPC markers, then stops only its own UI and broker.
        & "$source/scripts/ci-windows-smoke.ps1" -Binary (Join-Path $install 'sessionbay.exe')
        $result.launch = 'PASS'
    } catch {
        $primaryError = $_.Exception.Message
        foreach ($phase in @('install', 'launch')) {
            if ($result[$phase] -eq 'STARTED') { $result[$phase] = 'FAIL' }
        }
    } finally {
        if ($installed) {
            try {
                Assert-NoProductProcesses
                if ((Get-FileHash -LiteralPath (Join-Path $install 'uninstall.exe')).Hash -ne $uninstallerHash) {
                    throw 'Test-owned uninstaller changed; refusing execution.'
                }
                $result.uninstall = 'STARTED'
                # Normal /S, not /UPDATE or _?=. The uninstaller must remove itself.
                $result.uninstallLauncherExitCode = Invoke-OwnedExecutable (Join-Path $install 'uninstall.exe') '/S'
                $result.uninstallCompletion = Wait-SessionBayUninstallCompletion -Snapshot {
                    [pscustomobject]@{
                        DirectoryExists = Test-Path -LiteralPath $install
                        Registrations = @(Get-ProductRegistration)
                        Shortcuts = @($shortcutPaths | Where-Object { Test-Path -LiteralPath $_ })
                    }
                }
                # Recheck after the combined wait; no manual cleanup masks failure.
                if (Test-Path -LiteralPath $install) { throw 'Installed program directory was not removed.' }
                if (@(Get-ProductRegistration).Count) { throw 'Uninstall registration remains.' }
                if ((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).'Session Bay') {
                    throw 'Unexpected product autostart remains.'
                }
                foreach ($path in $shortcutPaths) {
                    if (Test-Path -LiteralPath $path) { throw 'Unexpected product shortcut remains.' }
                }
                foreach ($path in $sentinels.Keys) {
                    if (!(Test-Path -LiteralPath $path) -or (Get-FileHash $path).Hash -ne $sentinels[$path]) {
                        throw 'Normal uninstall removed or modified retained synthetic app data.'
                    }
                }
                Assert-NoProductProcesses
                $result.uninstall = 'PASS'
                $result.cleanup = 'PASS'
                $result.retainedPreferences = Test-Path -LiteralPath "HKCU:\$productKey"
                $result.retention = 'NSIS retains product preferences and unchecked synthetic app/WebView data. Runner disposal handles them.'
            } catch {
                $result.uninstall = 'FAIL'
                $result.cleanup = 'FAIL'
                $result.cleanupError = $_.Exception.Message
                if (!$primaryError) { $primaryError = $_.Exception.Message }
            }
        }
        $result.error = $primaryError
        $result.status = if ($primaryError) { 'FAIL' } else { 'PASS' }
        $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'result.json') -Encoding utf8
        # Do not recursively delete failed state, app data, or product registry.
        # The hosted VM is disposable; evidence must not be turned into a false pass.
    }
    if ($primaryError) { throw $primaryError }
} finally { Pop-Location }

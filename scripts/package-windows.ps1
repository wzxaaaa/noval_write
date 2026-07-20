[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )

  Write-Host ""
  Write-Host "==> $Title" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE"
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found. Install Node.js 20 or newer and run this script again.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm was not found. Reinstall Node.js with npm enabled.'
}

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
  throw "Node.js 20 or newer is required. Current version: $(node --version)"
}

Write-Host "2D Manxie Windows packager" -ForegroundColor Green
Write-Host "Project: $projectRoot"
Write-Host "Node: $(node --version)"

# Prefer mirrors that are reachable from mainland China. Existing user-level
# environment variables still take precedence when a private mirror is used.
if (-not $env:ELECTRON_MIRROR) {
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}
if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

$iconPath = Join-Path $projectRoot 'resources\icon.ico'
if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
  $isAdministrator = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
  $developerMode = $false
  $developerModeKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
  if (Test-Path -LiteralPath $developerModeKey) {
    $developerModeSettings = Get-ItemProperty -LiteralPath $developerModeKey -ErrorAction SilentlyContinue
    $developerModeProperty = $developerModeSettings.PSObject.Properties['AllowDevelopmentWithoutDevLicense']
    $developerMode = $null -ne $developerModeProperty -and $developerModeProperty.Value -eq 1
  }

  if (-not $isAdministrator -and -not $developerMode) {
    Write-Host 'A custom EXE icon requires elevation on this Windows configuration.' -ForegroundColor Yellow
    Write-Host 'Requesting administrator permission to continue...' -ForegroundColor Yellow

    $elevatedArguments = @(
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', "`"$PSCommandPath`""
    )
    if ($SkipInstall) { $elevatedArguments += '-SkipInstall' }
    if ($SkipChecks) { $elevatedArguments += '-SkipChecks' }

    $elevatedProcess = Start-Process `
      -FilePath 'powershell.exe' `
      -ArgumentList $elevatedArguments `
      -Verb RunAs `
      -Wait `
      -PassThru
    exit $elevatedProcess.ExitCode
  }
}

if (-not $SkipInstall) {
  Invoke-Step 'Installing dependencies' { npm install --no-audit --no-fund }
}

if (-not $SkipChecks) {
  Invoke-Step 'Checking TypeScript' { npm run lint }
  Invoke-Step 'Running tests' { npm test -- --run }
}

if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
  Invoke-Step 'Building application assets' { npm run build }
  Invoke-Step 'Preparing the Windows application directory' {
    npx electron-builder --win dir --x64 `
      --config.win.signAndEditExecutable=false
  }

  $executablePath = Join-Path $projectRoot 'release\win-unpacked\noval-write.exe'
  Invoke-Step 'Applying resources/icon.ico to the application' {
    node scripts/apply-windows-resources.cjs $executablePath $iconPath
  }

  Invoke-Step 'Building the Windows installer with resources/icon.ico' {
    npx electron-builder --win nsis --x64 `
      --prepackaged=release/win-unpacked `
      --config.win.signAndEditExecutable=false `
      --config.nsis.installerIcon=resources/icon.ico `
      --config.nsis.uninstallerIcon=resources/icon.ico `
      --config.nsis.installerHeaderIcon=resources/icon.ico
  }
} else {
  Write-Host 'No resources/icon.ico found; the default Electron icon will be used.' -ForegroundColor Yellow
  Invoke-Step 'Building the Windows installer' { npm run dist:win }
}

$installer = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'release') -Filter '*.exe' -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $installer) {
  throw 'Packaging completed, but no EXE file was found in the release directory.'
}

Write-Host ""
Write-Host 'Packaging completed successfully.' -ForegroundColor Green
Write-Host "Installer: $($installer.FullName)" -ForegroundColor Green

if ($Host.Name -eq 'ConsoleHost') {
  Start-Process explorer.exe -ArgumentList "/select,`"$($installer.FullName)`""
}

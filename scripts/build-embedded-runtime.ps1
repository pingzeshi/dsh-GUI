[CmdletBinding()]
param(
  [string]$Distro = 'Ubuntu',
  [switch]$Force,
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtimeDir = Join-Path $projectRoot 'runtime'
$configPath = Join-Path $runtimeDir 'runtime-config.json'
$manifestPath = Join-Path $runtimeDir 'manifest.json'

function Read-JsonFile([string]$Path) {
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Assert-SafeToken([string]$Name, [string]$Value, [string]$Pattern) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch $Pattern) {
    throw "$Name contains an unsupported value: $Value"
  }
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $hasher.ComputeHash($stream)
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $hasher.Dispose()
    $stream.Dispose()
  }
}

function Test-RuntimeArtifact($Config) {
  $archivePath = Join-Path $runtimeDir $Config.archiveName
  if (!(Test-Path -LiteralPath $archivePath -PathType Leaf) -or
      !(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Write-Verbose "Runtime archive or manifest is missing: $archivePath / $manifestPath"
    return $false
  }

  try {
    $manifest = Read-JsonFile $manifestPath
    foreach ($property in @('schemaVersion', 'runtimeId', 'platform', 'arch', 'nodeVersion', 'pnpmVersion', 'dshVersion', 'archiveName')) {
      if ([string]$manifest.$property -cne [string]$Config.$property) {
        Write-Verbose "Manifest mismatch for ${property}: '$($manifest.$property)' != '$($Config.$property)'"
        return $false
      }
    }
    if ([string]$manifest.archiveSha256 -notmatch '^[0-9a-f]{64}$') {
      Write-Verbose 'Manifest archiveSha256 is invalid.'
      return $false
    }
    $file = Get-Item -LiteralPath $archivePath
    if ([long]$manifest.archiveSize -ne $file.Length) {
      Write-Verbose "Manifest archiveSize mismatch: $($manifest.archiveSize) != $($file.Length)"
      return $false
    }
    $actualSha = Get-Sha256 $archivePath
    if ($actualSha -cne [string]$manifest.archiveSha256) {
      Write-Verbose "Manifest archiveSha256 mismatch: $($manifest.archiveSha256) != $actualSha"
      return $false
    }
    return $true
  } catch {
    Write-Verbose "Runtime verification failed: $($_.Exception.Message)"
    return $false
  }
}

function Wait-RuntimeArtifact($Config, [int]$Attempts = 8) {
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    if (Test-RuntimeArtifact $Config) {
      return $true
    }
    if ($attempt -lt $Attempts) {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "Missing runtime configuration: $configPath"
}
if ([string]::IsNullOrWhiteSpace($Distro) -or $Distro -match "[\r\n\0]") {
  throw 'Distro contains unsupported characters.'
}

$config = Read-JsonFile $configPath
Assert-SafeToken 'runtimeId' ([string]$config.runtimeId) '^[a-z0-9][a-z0-9._-]+$'
Assert-SafeToken 'nodeVersion' ([string]$config.nodeVersion) '^\d+\.\d+\.\d+$'
Assert-SafeToken 'pnpmVersion' ([string]$config.pnpmVersion) '^\d+\.\d+\.\d+$'
Assert-SafeToken 'dshVersion' ([string]$config.dshVersion) '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$'
Assert-SafeToken 'nodeArchiveSha256' ([string]$config.nodeArchiveSha256) '^[0-9a-f]{64}$'
Assert-SafeToken 'archiveName' ([string]$config.archiveName) '^[a-z0-9][a-z0-9._-]+\.tar\.gz$'

if (!$Force -and (Test-RuntimeArtifact $config)) {
  $archivePath = Join-Path $runtimeDir $config.archiveName
  $manifest = Read-JsonFile $manifestPath
  Write-Host "RUNTIME_READY id=$($manifest.runtimeId) archive=$archivePath sha256=$($manifest.archiveSha256)"
  exit 0
}

if ($VerifyOnly) {
  throw 'Embedded runtime is missing or does not match its manifest. Run npm run runtime:build.'
}

$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
try {
  $projectWslOutput = & wsl.exe -d $Distro --exec wslpath -a -u $projectRoot 2>$null
  $wslPathExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorAction
}
if ($wslPathExitCode -ne 0) {
  throw "Unable to map the project directory in WSL distro '$Distro'."
}
$projectWsl = [string]($projectWslOutput | Select-Object -Last 1)
$projectWsl = $projectWsl.Trim()
if ($projectWsl -notmatch '^/') {
  throw "WSL returned an invalid project path: $projectWsl"
}

$builderWsl = "$projectWsl/scripts/build-embedded-runtime.sh"
$ErrorActionPreference = 'Continue'
try {
  & wsl.exe -d $Distro --exec /bin/bash $builderWsl `
    $projectWsl `
    ([string]$config.runtimeId) `
    ([string]$config.nodeVersion) `
    ([string]$config.nodeArchiveSha256) `
    ([string]$config.pnpmVersion) `
    ([string]$config.dshVersion) `
    ([string]$config.archiveName)
  $runtimeBuildExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorAction
}
if ($runtimeBuildExitCode -ne 0) {
  throw "WSL runtime build failed with exit code $runtimeBuildExitCode."
}

if (!(Wait-RuntimeArtifact $config)) {
  throw 'The generated embedded runtime failed manifest verification.'
}

$archivePath = Join-Path $runtimeDir $config.archiveName
$manifest = Read-JsonFile $manifestPath
Write-Host "RUNTIME_BUILT id=$($manifest.runtimeId) archive=$archivePath sha256=$($manifest.archiveSha256)"

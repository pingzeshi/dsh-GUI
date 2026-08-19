[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtimeDir = Join-Path $projectRoot 'runtime'
$configPath = Join-Path $runtimeDir 'runtime-config-win32.json'
$archiveTool = Join-Path $PSScriptRoot 'runtime-archive.mjs'

function Read-JsonFile([string]$Path) {
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
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
  $manifestPath = Join-Path $runtimeDir $Config.manifestName
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
      return $false
    }
    $file = Get-Item -LiteralPath $archivePath
    if ([long]$manifest.archiveSize -ne $file.Length) {
      return $false
    }
    return (Get-Sha256 $archivePath) -ceq [string]$manifest.archiveSha256
  } catch {
    Write-Verbose "Runtime verification failed: $($_.Exception.Message)"
    return $false
  }
}

function Invoke-Download([string]$Uri, [string]$OutFile) {
  $lastError = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
      return
    } catch {
      $lastError = $_
      if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) }
    }
  }
  throw $lastError
}

if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "Missing runtime configuration: $configPath"
}
if (!(Test-Path -LiteralPath $archiveTool -PathType Leaf)) {
  throw "Missing runtime archive tool: $archiveTool"
}

$config = Read-JsonFile $configPath
Assert-SafeToken 'runtimeId' ([string]$config.runtimeId) '^[a-z0-9][a-z0-9._-]+$'
Assert-SafeToken 'nodeVersion' ([string]$config.nodeVersion) '^\d+\.\d+\.\d+$'
Assert-SafeToken 'pnpmVersion' ([string]$config.pnpmVersion) '^\d+\.\d+\.\d+$'
Assert-SafeToken 'dshVersion' ([string]$config.dshVersion) '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$'
Assert-SafeToken 'nodeArchiveSha256' ([string]$config.nodeArchiveSha256) '^[0-9a-f]{64}$'
Assert-SafeToken 'archiveName' ([string]$config.archiveName) '^[a-z0-9][a-z0-9._-]+\.tar\.gz$'
Assert-SafeToken 'manifestName' ([string]$config.manifestName) '^manifest-[a-z0-9._-]+\.json$'
if ([string]$config.platform -cne 'win32' -or [string]$config.arch -cne 'x64') {
  throw 'Windows runtime configuration must target win32-x64.'
}

if (!$Force -and (Test-RuntimeArtifact $config)) {
  $archivePath = Join-Path $runtimeDir $config.archiveName
  $manifestPath = Join-Path $runtimeDir $config.manifestName
  $manifest = Read-JsonFile $manifestPath
  Write-Host "RUNTIME_READY id=$($manifest.runtimeId) archive=$archivePath sha256=$($manifest.archiveSha256)"
  exit 0
}
if ($VerifyOnly) {
  throw 'Windows embedded runtime is missing or does not match its manifest.'
}

$packageJson = Join-Path $runtimeDir 'package.json'
$pnpmLock = Join-Path $runtimeDir 'pnpm-lock.yaml'
$pnpmWorkspace = Join-Path $runtimeDir 'pnpm-workspace.yaml'
$notices = Join-Path $runtimeDir 'THIRD_PARTY_NOTICES.md'
foreach ($required in @($packageJson, $pnpmLock, $pnpmWorkspace, $notices)) {
  if (!(Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing runtime build input: $required"
  }
}

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$workDir = Join-Path $tempRoot ('dsh-desktop-win32-runtime-build-' + [guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $runtimeDir ([string]$config.archiveName)
$manifestPath = Join-Path $runtimeDir ([string]$config.manifestName)
$archiveTmp = Join-Path $runtimeDir ('.' + [string]$config.archiveName + '.tmp.' + $PID)
$manifestTmp = Join-Path $runtimeDir ('.' + [string]$config.manifestName + '.tmp.' + $PID)

New-Item -ItemType Directory -Path $workDir | Out-Null
try {
  $nodeZip = Join-Path $workDir 'node.zip'
  $nodeExtract = Join-Path $workDir 'node-dist'
  $appDir = Join-Path $workDir 'app'
  $stageDir = Join-Path $workDir 'stage'
  $verifyDir = Join-Path $workDir 'verify'
  New-Item -ItemType Directory -Path $nodeExtract, $appDir, $stageDir, $verifyDir | Out-Null

  $nodeUrl = "https://nodejs.org/dist/v$($config.nodeVersion)/node-v$($config.nodeVersion)-win-x64.zip"
  Write-Host "Downloading Windows x64 Node.js v$($config.nodeVersion)"
  Invoke-Download $nodeUrl $nodeZip
  $nodeZipSha = Get-Sha256 $nodeZip
  if ($nodeZipSha -cne [string]$config.nodeArchiveSha256) {
    throw "Node.js archive SHA-256 mismatch: $nodeZipSha"
  }
  Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract
  $nodeRoot = Join-Path $nodeExtract "node-v$($config.nodeVersion)-win-x64"
  $nodeExe = Join-Path $nodeRoot 'node.exe'
  $corepackCmd = Join-Path $nodeRoot 'corepack.cmd'
  if (!(Test-Path -LiteralPath $nodeExe -PathType Leaf) -or
      !(Test-Path -LiteralPath $corepackCmd -PathType Leaf)) {
    throw 'Downloaded Node.js archive is incomplete.'
  }
  if ((& $nodeExe --version) -cne "v$($config.nodeVersion)") {
    throw 'Downloaded Node.js version does not match configuration.'
  }

  Copy-Item -LiteralPath $packageJson, $pnpmLock, $pnpmWorkspace -Destination $appDir
  $savedCorepackHome = $env:COREPACK_HOME
  $env:COREPACK_HOME = Join-Path $workDir 'corepack'
  try {
    Push-Location $appDir
    try {
      Write-Host "Installing Windows native dsh $($config.dshVersion) from the lockfile"
      & $corepackCmd "pnpm@$($config.pnpmVersion)" install --prod --frozen-lockfile `
        --ignore-scripts=false --reporter=append-only --config.node-linker=hoisted
      if ($LASTEXITCODE -ne 0) {
        throw "pnpm install failed with exit code $LASTEXITCODE."
      }
    } finally {
      Pop-Location
    }
  } finally {
    $env:COREPACK_HOME = $savedCorepackHome
  }

  $dshScript = Join-Path $appDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (!(Test-Path -LiteralPath $dshScript -PathType Leaf)) {
    throw 'dsh entrypoint is missing after pnpm install.'
  }
  if ((& $nodeExe $dshScript --version) -cne [string]$config.dshVersion) {
    throw 'Installed dsh version does not match configuration.'
  }

  $stageNodeModules = Join-Path $stageDir 'lib\node_modules'
  New-Item -ItemType Directory -Path (Join-Path $stageDir 'lib'), (Join-Path $stageDir 'share\licenses\node'), (Join-Path $stageDir 'share\dsh-desktop') | Out-Null
  Move-Item -LiteralPath (Join-Path $appDir 'node_modules') -Destination $stageNodeModules
  foreach ($metadata in @('.modules.yaml', '.package-map.json', '.pnpm-workspace-state-v1.json', '.pnpm')) {
    $metadataPath = Join-Path $stageNodeModules $metadata
    if (Test-Path -LiteralPath $metadataPath) {
      Remove-Item -LiteralPath $metadataPath -Recurse -Force
    }
  }
  Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $stageDir 'node.exe')
  Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination (Join-Path $stageDir 'share\licenses\node\LICENSE')
  Copy-Item -LiteralPath $notices -Destination (Join-Path $stageDir 'share\dsh-desktop\THIRD_PARTY_NOTICES.md')
  Copy-Item -LiteralPath $pnpmLock -Destination (Join-Path $stageDir 'share\dsh-desktop\runtime-pnpm-lock.yaml')

  $runtimeMetadata = [ordered]@{
    schemaVersion = 1
    runtimeId = [string]$config.runtimeId
    platform = 'win32'
    arch = 'x64'
    nodeVersion = [string]$config.nodeVersion
    pnpmVersion = [string]$config.pnpmVersion
    dshVersion = [string]$config.dshVersion
  } | ConvertTo-Json
  Write-Utf8NoBom (Join-Path $stageDir 'runtime.json') ($runtimeMetadata + "`n")

  $stageDshScript = Join-Path $stageDir 'lib\node_modules\@deepseek-ai\dsh\lib\bin.js'
  if ((& (Join-Path $stageDir 'node.exe') $stageDshScript --version) -cne [string]$config.dshVersion) {
    throw 'Staged Windows runtime verification failed.'
  }
  $reparsePoints = @(Get-ChildItem -LiteralPath $stageDir -Recurse -Force -Attributes ReparsePoint)
  if ($reparsePoints.Count -ne 0) {
    throw "Staged Windows runtime contains $($reparsePoints.Count) reparse points."
  }

  Write-Host 'Creating deterministic Windows runtime archive'
  & $nodeExe $archiveTool create $stageDir $archiveTmp
  if ($LASTEXITCODE -ne 0) {
    throw "Runtime archive creation failed with exit code $LASTEXITCODE."
  }
  & $nodeExe $archiveTool extract $archiveTmp $verifyDir
  if ($LASTEXITCODE -ne 0) {
    throw "Runtime archive extraction failed with exit code $LASTEXITCODE."
  }
  if ((& (Join-Path $verifyDir 'node.exe') (Join-Path $verifyDir 'lib\node_modules\@deepseek-ai\dsh\lib\bin.js') --version) -cne [string]$config.dshVersion) {
    throw 'Extracted Windows runtime verification failed.'
  }

  $archiveFile = Get-Item -LiteralPath $archiveTmp
  $archiveSha = Get-Sha256 $archiveTmp
  $manifest = [ordered]@{
    schemaVersion = 1
    runtimeId = [string]$config.runtimeId
    platform = 'win32'
    arch = 'x64'
    nodeVersion = [string]$config.nodeVersion
    pnpmVersion = [string]$config.pnpmVersion
    dshVersion = [string]$config.dshVersion
    archiveName = [string]$config.archiveName
    archiveSize = [long]$archiveFile.Length
    archiveSha256 = $archiveSha
  } | ConvertTo-Json
  Write-Utf8NoBom $manifestTmp ($manifest + "`n")

  Move-Item -LiteralPath $archiveTmp -Destination $archivePath -Force
  Move-Item -LiteralPath $manifestTmp -Destination $manifestPath -Force
} finally {
  foreach ($temporaryFile in @($archiveTmp, $manifestTmp)) {
    if (Test-Path -LiteralPath $temporaryFile) {
      Remove-Item -LiteralPath $temporaryFile -Force
    }
  }
  $workFull = [System.IO.Path]::GetFullPath($workDir)
  if ($workFull.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $workFull) -like 'dsh-desktop-win32-runtime-build-*' -and
      (Test-Path -LiteralPath $workFull)) {
    Remove-Item -LiteralPath $workFull -Recurse -Force
  }
}

if (!(Test-RuntimeArtifact $config)) {
  throw 'The generated Windows embedded runtime failed manifest verification.'
}
$manifest = Read-JsonFile $manifestPath
Write-Host "RUNTIME_BUILT id=$($manifest.runtimeId) archive=$archivePath sha256=$($manifest.archiveSha256)"

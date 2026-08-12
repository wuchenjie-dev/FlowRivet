param(
  [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$GitLabBaseUrl,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]+$')][string]$ProjectId,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version
)
$ErrorActionPreference = 'Stop'
$installRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'FlowRivet'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("flowrivet-install-" + [Guid]::NewGuid())
$token = Read-Host "GitLab Deploy Token" -AsSecureString
$plainToken = [System.Net.NetworkCredential]::new('', $token).Password
try {
  New-Item -ItemType Directory -Force -LiteralPath $temporaryRoot | Out-Null
  New-Item -ItemType Directory -Force -LiteralPath $installRoot | Out-Null
  $archive = Join-Path $temporaryRoot 'flowrivet-runtime.tar.gz'
  $manifestPath = Join-Path $temporaryRoot 'release-manifest.json'
  $packageBaseUrl = "$GitLabBaseUrl/api/v4/projects/$ProjectId/packages/generic/flowrivet-runtime/$Version"
  Invoke-WebRequest -Uri "$packageBaseUrl/release-manifest.json" -Headers @{ 'DEPLOY-TOKEN' = $plainToken } -OutFile $manifestPath
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $package = $manifest.packages.'win32-x64'
  $expectedFile = "flowrivet-runtime-win32-x64-v$Version.tar.gz"
  if ($manifest.schemaVersion -ne 1 -or $manifest.version -ne $Version -or $null -eq $package -or $package.file -ne $expectedFile) {
    throw 'flowrivet_manifest_invalid'
  }
  $url = "$packageBaseUrl/$expectedFile"
  Invoke-WebRequest -Uri $url -Headers @{ 'DEPLOY-TOKEN' = $plainToken } -OutFile $archive
  $archiveInfo = Get-Item -LiteralPath $archive
  if ($archiveInfo.Length -ne [Int64]$package.size) { throw 'flowrivet_package_size_mismatch' }
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
  if ($actualHash -ne ([string]$package.sha256).ToLowerInvariant()) { throw 'flowrivet_package_hash_mismatch' }
  $versionRoot = Join-Path $installRoot "versions\$Version"
  if (-not (Test-Path -LiteralPath $versionRoot)) {
    New-Item -ItemType Directory -Force -LiteralPath $versionRoot | Out-Null
    & tar.exe -xzf $archive -C $versionRoot
    if ($LASTEXITCODE -ne 0) { throw 'flowrivet_extract_failed' }
  }
  $pointer = @{ schemaVersion = 1; activeVersion = $Version; activatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $installRoot 'current.json'), $pointer + "`n", [Text.UTF8Encoding]::new($false))
  $updater = Join-Path $versionRoot 'runtime\node.exe'
  $updaterEntry = Join-Path $versionRoot 'app\packages\updater\dist\main.js'
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $updater
  $startInfo.ArgumentList.Add($updaterEntry)
  $startInfo.ArgumentList.Add('configure')
  $startInfo.ArgumentList.Add('--token-stdin')
  $startInfo.ArgumentList.Add('--gitlab-base-url')
  $startInfo.ArgumentList.Add($GitLabBaseUrl)
  $startInfo.ArgumentList.Add('--project-id')
  $startInfo.ArgumentList.Add($ProjectId)
  $startInfo.RedirectStandardInput = $true
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($startInfo)
  $process.StandardInput.WriteLine($plainToken)
  $process.StandardInput.Close()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw 'flowrivet_configure_failed' }
  $taskCommand = '"' + $updater + '" "' + $updaterEntry + '" run'
  & schtasks.exe /Create /F /SC ONLOGON /TN 'FlowRivet Updater' /TR $taskCommand /RL LIMITED | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'flowrivet_startup_failed' }
  Start-Process -FilePath $updater -ArgumentList @($updaterEntry, 'run') -WindowStyle Hidden
} finally {
  $plainToken = $null
  if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}

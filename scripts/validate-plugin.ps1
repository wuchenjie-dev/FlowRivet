param(
  [Parameter(Mandatory = $true)]
  [string]$PluginCreatorRoot
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$validator = Join-Path $PluginCreatorRoot "scripts\validate_plugin.py"

if (-not (Test-Path -LiteralPath $validator)) {
  throw "找不到 plugin-creator 校验器: $validator"
}

Push-Location $repositoryRoot
try {
  npm run build --workspace @flowrivet/codex-plugin
  if ($LASTEXITCODE -ne 0) { throw "Codex 插件构建失败。" }

  $python = Get-Command python -ErrorAction Stop
  $env:PYTHONUTF8 = "1"
  & $python.Source $validator $repositoryRoot
  if ($LASTEXITCODE -ne 0) { throw "Codex 插件清单校验失败。" }

  $health = $null
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:43120/health" -TimeoutSec 1
  }
  catch {
    Write-Host "[INFO] FlowRivet Companion 尚未运行。注册插件前请执行："
    Write-Host "       npm start --workspace @flowrivet/codex-plugin"
  }

  if ($null -ne $health) {
    if ($health.status -ne "ok") { throw "Companion 健康检查返回异常状态。" }
    Write-Host "[OK] FlowRivet Companion 正在运行。"
  }

  Write-Host "[OK] 插件包可用于本地 marketplace 注册。"
}
finally {
  Pop-Location
}

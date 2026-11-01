param(
  [switch]$ForceLocal
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $Root 'runtime'
$RuntimeNode = Join-Path $RuntimeRoot 'node'
$DirFile = Join-Path $RuntimeRoot 'node-dir.txt'
$MinVersion = [version]'22.5.0'

function Get-NodeVersion($exe) {
  try {
    $v = & $exe -p "process.versions.node" 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) { return [version]$v.Trim() }
  } catch {}
  return $null
}

function Use-Node($exe, $version) {
  New-Item -ItemType Directory -Force $RuntimeRoot | Out-Null
  $dir = Split-Path -Parent $exe
  Set-Content -Path $DirFile -Value $dir -Encoding ASCII
  Write-Host ("  Node.js " + $version + " 已就绪")
  exit 0
}

if (-not $ForceLocal) {
  $candidates = @()
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }
  $candidates += @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  foreach ($exe in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path $exe)) { continue }
    $v = Get-NodeVersion $exe
    if ($v -and $v -ge $MinVersion) { Use-Node $exe $v }
  }
}

# 本地便携版优先
$localExe = Join-Path $RuntimeNode 'node.exe'
if (Test-Path $localExe) {
  $v = Get-NodeVersion $localExe
  if ($v -and $v -ge $MinVersion) { Use-Node $localExe $v }
}

Write-Host ''
Write-Host '  未检测到 Node.js 22.5+，正在自动下载便携版…'
Write-Host '  （约 30MB，只需下载一次，不需要管理员权限）'
Write-Host ''

$arch = switch -Regex ($env:PROCESSOR_ARCHITECTURE) {
  'ARM64' { 'arm64'; break }
  'x86'   { 'x86'; break }
  default { 'x64' }
}

$indexUrls = @(
  'https://nodejs.org/dist/index.json',
  'https://npmmirror.com/mirrors/node/index.json'
)
$index = $null
foreach ($u in $indexUrls) {
  try {
    $data = Invoke-RestMethod -Uri $u -UseBasicParsing -TimeoutSec 20
    if ($data) { $index = $data; break }
  } catch {}
}
if (-not $index) {
  Write-Host '  [错误] 无法获取 Node.js 版本列表，请检查网络。'
  Write-Host '         也可以手动安装：https://nodejs.org/en/download'
  exit 1
}

$pick = $index |
  Where-Object {
    $_.lts -and $_.version -match '^v(\d+)\.' -and ([version]($_.version.TrimStart('v'))) -ge $MinVersion
  } |
  Select-Object -First 1
if (-not $pick) {
  Write-Host '  [错误] 没有找到合适的 Node.js LTS 版本。'
  exit 1
}

$ver = $pick.version
$zipName = "node-$ver-win-$arch.zip"
$urls = @(
  "https://nodejs.org/dist/$ver/$zipName",
  "https://npmmirror.com/mirrors/node/$ver/$zipName"
)

New-Item -ItemType Directory -Force $RuntimeRoot | Out-Null
$tmpZip = Join-Path $RuntimeRoot 'node.zip'
$tmpDir = Join-Path $RuntimeRoot '_node_tmp'
$downloaded = $false
foreach ($url in $urls) {
  try {
    Write-Host ("  下载 " + $url)
    Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing -TimeoutSec 180
    if ((Get-Item $tmpZip).Length -gt 10MB) { $downloaded = $true; break }
  } catch {
    Write-Host ('  下载失败：' + $_.Exception.Message)
  }
}
if (-not $downloaded) {
  Write-Host '  [错误] Node.js 下载失败，请检查网络或手动安装：https://nodejs.org/en/download'
  exit 1
}

try {
  if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
  Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
  $inner = Get-ChildItem $tmpDir -Directory | Select-Object -First 1
  if (-not $inner) { throw '压缩包内容异常' }
  if (Test-Path $RuntimeNode) { Remove-Item $RuntimeNode -Recurse -Force }
  Move-Item $inner.FullName $RuntimeNode
  Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
  Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  Write-Host ('  [错误] Node.js 解压失败：' + $_.Exception.Message)
  exit 1
}

$v = Get-NodeVersion (Join-Path $RuntimeNode 'node.exe')
if (-not $v -or $v -lt $MinVersion) {
  Write-Host '  [错误] Node.js 安装后仍不可用。'
  exit 1
}
Use-Node (Join-Path $RuntimeNode 'node.exe') $v

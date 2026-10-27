<#
.SYNOPSIS
  三层记忆插件 · 一键安装（Windows / PowerShell 5.1+）

.DESCRIPTION
  把本包里的记忆模块复制进你的 qq-bridge 仓库，然后调用官方安装器接线。
  支持三种跑法：
    .\install-memory.ps1                             # 当前目录就是 qq-bridge 仓库
    .\install-memory.ps1 -Repo D:\my-qq-bridge       # 指定仓库
    .\install-memory.ps1 -Check                      # 只自检锚点，一个字节都不改

.PARAMETER Repo
  qq-bridge 仓库根目录（含 src\bridge.js 的那层）。省略 = 当前目录。

.PARAMETER Check
  只检查安装锚点是否匹配（版本兼容性），不修改任何文件。

.PARAMETER Node
  node.exe 的完整路径。PATH 里没有 node 时用这个。

.PARAMETER SkipTests
  装完不跑单元测试。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-memory.ps1 -Repo D:\qq-bridge -Check
#>
param(
  [string]$Repo = '',
  [switch]$Check,
  [string]$Node = '',
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$pkgRoot = $PSScriptRoot

function Say($m, $color = 'Gray') { Write-Host $m -ForegroundColor $color }
function Fail($m) { Write-Host "`n✗ $m" -ForegroundColor Red; exit 1 }

# ── 1) 找 node ───────────────────────────────────────────────────────────
$nodeExe = $Node
if (-not $nodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodeExe = $cmd.Source }
}
if (-not $nodeExe -or -not (Test-Path $nodeExe)) {
  Fail ("找不到 node.exe。请先装 Node.js >= 22.13（https://nodejs.org），`n" +
        "  或用参数指定：.\install-memory.ps1 -Node 'C:\Program Files\nodejs\node.exe'")
}
$verText = (& $nodeExe -v 2>&1).Trim()
Say "node  : $nodeExe ($verText)"
if ($verText -match '^v(\d+)\.(\d+)\.(\d+)') {
  $maj = [int]$Matches[1]; $min = [int]$Matches[2]
  if ($maj -lt 22 -or ($maj -eq 22 -and $min -lt 13)) {
    Fail "node 版本过低（$verText），需要 >= 22.13（本插件用了较新的 fs/path API）。"
  }
}

# ── 2) 找仓库 ────────────────────────────────────────────────────────────
if (-not $Repo) { $Repo = (Get-Location).Path }
if (-not (Test-Path $Repo)) { Fail "仓库目录不存在：$Repo" }
$Repo = (Resolve-Path $Repo).Path
$bridge = Join-Path $Repo 'src\bridge.js'
$pkgJson = Join-Path $Repo 'package.json'
if (-not (Test-Path $bridge)) {
  Fail ("$Repo 里没有 src\bridge.js。`n请在 qq-bridge 仓库根目录运行，或用 -Repo 指定。")
}
Say "仓库  : $Repo"

if (Test-Path $pkgJson) {
  try {
    $ver = (Get-Content $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json).version
    Say "版本  : qq-bridge $ver（锚点按 0.2.1-r1 编写）"
    if ($ver -ne '0.2.1-r1') {
      Say "  ⚠ 版本不是 0.2.1-r1：安装器会以「锚点不存在」安全退出，不会改坏文件。" 'Yellow'
      Say "    建议先加 -Check 跑一次自检。" 'Yellow'
    }
  } catch { Say "  （package.json 读不出来，跳过版本检查）" 'Yellow' }
}

# ── 3) 复制模块文件 ──────────────────────────────────────────────────────
if ($Check) { Say "`n[1/2] --Check 模式：跳过复制，只自检锚点" 'Cyan' }
else {
  Say "`n[1/3] 复制模块文件" 'Cyan'
  $dstMemory = Join-Path $Repo 'src\memory'
  $dstScripts = Join-Path $Repo 'scripts'
  New-Item -ItemType Directory -Force -Path $dstMemory, $dstScripts | Out-Null

  $srcMemory = Join-Path $pkgRoot 'src\memory'
  $srcScripts = Join-Path $pkgRoot 'scripts'
  if (-not (Test-Path $srcMemory)) { Fail "包不完整：缺 src\memory 目录。请重新解压整个压缩包。" }

  $count = 0
  Get-ChildItem $srcMemory -Filter *.mjs | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dstMemory $_.Name) -Force
    Say ("  · src\memory\" + $_.Name); $count++
  }
  Get-ChildItem $srcScripts -Filter *.mjs | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dstScripts $_.Name) -Force
    Say ("  · scripts\" + $_.Name); $count++
  }
  Say "  共复制 $count 个文件" 'Green'
}

# ── 4) 跑安装器 ──────────────────────────────────────────────────────────
$installer = Join-Path $Repo 'scripts\install-memory.mjs'
if (-not (Test-Path $installer)) { Fail "找不到 $installer（复制步骤没跑？）" }

if ($Check) {
  Say "`n[2/2] 锚点自检" 'Cyan'
  Push-Location $Repo
  try { & $nodeExe $installer --check } finally { Pop-Location }
  exit $LASTEXITCODE
}

Say "`n[2/3] 接线（改 src\bridge.js，自动备份 + 语法检查）" 'Cyan'
Push-Location $Repo
try {
  & $nodeExe $installer
  if ($LASTEXITCODE -ne 0) { Fail "安装器退出码 $LASTEXITCODE（文件已被自动回滚，原样未动）" }
} finally { Pop-Location }

# ── 5) 自检 ──────────────────────────────────────────────────────────────
if (-not $SkipTests) {
  Say "`n[3/3] 单元测试" 'Cyan'
  Push-Location $Repo
  try {
    & $nodeExe 'scripts\test-memory-store.mjs'
    $a = $LASTEXITCODE
    & $nodeExe 'scripts\test-memory-digest.mjs'
    $b = $LASTEXITCODE
    if (Test-Path (Join-Path $Repo 'node_modules\@modelcontextprotocol\sdk')) {
      & $nodeExe 'scripts\test-memory-mcp.mjs'
      $c = $LASTEXITCODE
    } else {
      Say '  （跳过 mcp 测试：仓库还没 npm install，缺 @modelcontextprotocol/sdk）' 'Yellow'
      $c = 0
    }
    if ($a -ne 0 -or $b -ne 0 -or $c -ne 0) {
      Say "`n⚠ 有测试没过。模块仍可用，但请把这些输出发给帮你装的人。" 'Yellow'
    } else {
      Say "`n✓ 已跑的测试全部通过" 'Green'
    }
  } finally { Pop-Location }
}

Say "`n================ 装好了，还剩三步 ================" 'Cyan'
Say "1) 把 $Repo\config.example.json 里的 `"memory`" 整段抄进你的 config.json"
Say "   （放在 `"slang`" 段后面；没有 config.json 就先复制 example 再改）"
Say "2) 重启桥接（记忆调度器在启动时挂载）"
Say "3) 可选：把 mcp-memory 挂进 DSH 的 cordis.patch.yml，让 AI 能主动查记忆"
Say "   详见包内 README.md 的「可选：让 AI 能主动查记忆」一节"
Say "==================================================" 'Cyan'
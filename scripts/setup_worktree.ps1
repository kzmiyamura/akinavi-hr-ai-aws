# setup_worktree.ps1 — 作業用の git worktree を作って、gitignore 対象を持ち込む
#
# 常駐ワーカー(pm2)はメインの作業ツリーをそのまま実行しているため、
# メインで branch を checkout すると**本番ワーカーが実験コードになる**。
# ブランチ作業は必ず worktree で行う（2026-08-14 に運用開始）。
#
# worktree には gitignore 対象が入らないので、以下を手当てする:
#   node_modules       … ジャンクション（コピーすると数分かかる）
#   .env.local         … 無いと vitest が4ファイル失敗する（環境要因の偽の赤）
#   scripts/testData/  … PII のため git 管理外。無いと Excel 回帰が Total 0 で空回りする
#
# 使い方: powershell -File scripts/setup_worktree.ps1 -Branch feat/xxx [-Path ..\akinavi-wt-xxx]
param(
  [Parameter(Mandatory = $true)][string]$Branch,
  [string]$Path
)

$main = Split-Path -Parent $PSScriptRoot
if (-not $Path) { $Path = Join-Path (Split-Path -Parent $main) ("akinavi-wt-" + ($Branch -replace '.*/', '')) }

git -C $main worktree add $Path -b $Branch
if ($LASTEXITCODE -ne 0) { Write-Error "worktree の作成に失敗しました"; exit 1 }

if (-not (Test-Path "$Path\node_modules")) {
  New-Item -ItemType Junction -Path "$Path\node_modules" -Target "$main\node_modules" | Out-Null
}
Get-ChildItem $main -Filter ".env*" -Force | ForEach-Object { Copy-Item $_.FullName $Path -Force }
New-Item -ItemType Directory -Force "$Path\scripts\testData" | Out-Null
foreach ($d in @("excel", "failures")) {
  if (Test-Path "$main\scripts\testData\$d") {
    Copy-Item "$main\scripts\testData\$d" "$Path\scripts\testData\" -Recurse -Force
  }
}

Write-Output ""
Write-Output "worktree: $Path  (branch: $Branch)"
Write-Output "  node_modules : ジャンクション"
Write-Output "  .env         : コピー済み"
Write-Output ("  testData/excel: " + (Get-ChildItem "$Path\scripts\testData\excel" -ErrorAction SilentlyContinue).Count + " 件")
Write-Output ""
Write-Output "終わったら: git -C `"$main`" worktree remove `"$Path`""


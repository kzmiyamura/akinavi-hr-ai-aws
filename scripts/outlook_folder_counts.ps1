# outlook_folder_counts.ps1 — Outlook の各フォルダの件数を数えるだけ（2026-09-24）
#
# 目的: 「受信トレイに何件／削除済みに何件」を実測する。
# 読むだけ。既読状態も中身も一切触らない（Items.Count と最古/最新の受信時刻のみ）。
#
# 実行: powershell -ExecutionPolicy Bypass -File scripts\outlook_folder_counts.ps1

$ErrorActionPreference = 'Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")

Write-Output ("{0,-26} {1,8}  {2,-17} {3,-17}" -f "フォルダ", "件数", "最古の受信", "最新の受信")
Write-Output ("-" * 74)

$total = 0
foreach ($store in $ns.Stores) {
  if ($store.DisplayName -notlike "akinavi*") { continue }
  # 6=受信トレイ, 3=削除済みアイテム, 5=送信済み, 23=迷惑メール, 4=送信トレイ
  foreach ($id in @(6, 3, 23, 5, 4)) {
    $f = $null
    try { $f = $store.GetDefaultFolder($id) } catch { continue }
    if (-not $f) { continue }
    $n = $f.Items.Count
    $total += $n
    $oldest = ""
    $newest = ""
    if ($n -gt 0) {
      try {
        $items = $f.Items
        $items.Sort("[ReceivedTime]", $false)
        $oldest = "{0:MM/dd HH:mm}" -f $items.GetFirst().ReceivedTime
        $items.Sort("[ReceivedTime]", $true)
        $newest = "{0:MM/dd HH:mm}" -f $items.GetFirst().ReceivedTime
      } catch { }
    }
    Write-Output ("{0,-26} {1,8}  {2,-17} {3,-17}" -f $f.Name, $n, $oldest, $newest)
  }
}
Write-Output ("-" * 74)
Write-Output ("合計 {0} 件" -f $total)



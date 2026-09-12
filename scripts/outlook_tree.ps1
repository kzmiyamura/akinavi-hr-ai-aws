# Outlook の全ストア・全フォルダを歩いて、件数の多い場所を探す（読み取りのみ）。
#
# 既定の受信トレイだけ見ても取り込み対象は見つからない。
# アプリは特定のメールボックスを Graph でポーリングしているので、
# そのフォルダがどこにあるか（別アカウント・サブフォルダ・アーカイブ）を突き止める。
#
# 使い方: powershell -ExecutionPolicy Bypass -File scripts\outlook_tree.ps1 [最小件数]

$Min = if ($args.Count -ge 1) { [int]$args[0] } else { 1 }

try {
  $ol = New-Object -ComObject Outlook.Application
} catch {
  Write-Output "Outlook に接続できません: $($_.Exception.Message)"
  exit 1
}
$ns = $ol.GetNamespace("MAPI")

$rows = New-Object System.Collections.ArrayList

function Walk($folder, $path, $depth) {
  if ($depth -gt 6) { return }
  $count = 0
  try { $count = $folder.Items.Count } catch { }
  if ($count -ge $Min) {
    $null = $rows.Add([PSCustomObject]@{ 件数 = $count; パス = $path })
  }
  try {
    foreach ($sub in $folder.Folders) { Walk $sub "$path\$($sub.Name)" ($depth + 1) }
  } catch { }
}

foreach ($store in $ns.Folders) {
  Walk $store $store.Name 0
}

$rows | Sort-Object 件数 -Descending | Select-Object -First 30 | Format-Table -AutoSize
Write-Output ""
Write-Output ("フォルダ総数（{0}件以上）: {1}" -f $Min, $rows.Count)


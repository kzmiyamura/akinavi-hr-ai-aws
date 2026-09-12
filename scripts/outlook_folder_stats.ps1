# 指定フォルダの中身を数える（読み取りのみ）。エクスポートする価値があるか判断するため。
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File scripts\outlook_folder_stats.ps1 "k.miyamura@i-voice.co.jp\受信トレイ"

if ($args.Count -lt 1) { Write-Output '使い方: outlook_folder_stats.ps1 "<ストア>\<フォルダ>"'; exit 1 }
$Target = $args[0]

$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")

function Find-Folder($path) {
  $parts = $path -split '\\'
  $cur = $null
  foreach ($store in $ns.Folders) { if ($store.Name -eq $parts[0]) { $cur = $store; break } }
  if (-not $cur) { return $null }
  for ($i = 1; $i -lt $parts.Count; $i++) {
    $next = $null
    foreach ($f in $cur.Folders) { if ($f.Name -eq $parts[$i]) { $next = $f; break } }
    if (-not $next) { return $null }
    $cur = $next
  }
  return $cur
}

$folder = Find-Folder $Target
if (-not $folder) { Write-Output "フォルダが見つかりません: $Target"; exit 1 }

$items = $folder.Items
$items.Sort("[ReceivedTime]", $true)

$n = 0; $withAtt = 0; $bytes = 0
$ext = @{}
$oldest = $null; $newest = $null
$senders = @{}

foreach ($m in $items) {
  if ($m.Class -ne 43) { continue }
  $n++
  $rt = $m.ReceivedTime
  if (-not $newest -or $rt -gt $newest) { $newest = $rt }
  if (-not $oldest -or $rt -lt $oldest) { $oldest = $rt }
  $addr = ""
  try { $addr = $m.SenderEmailAddress } catch { }
  if ($addr) {
    $dom = ($addr -split '@')[-1].ToLower()
    $senders[$dom] = [int]$senders[$dom] + 1
  }
  if ($m.Attachments.Count -gt 0) {
    $withAtt++
    foreach ($a in $m.Attachments) {
      $bytes += $a.Size
      $e = [System.IO.Path]::GetExtension($a.FileName).ToLower()
      if (-not $e) { $e = "(なし)" }
      $ext[$e] = [int]$ext[$e] + 1
    }
  }
}

Write-Output "フォルダ: $Target"
Write-Output ("メール {0} 件 / 添付あり {1} 件 / 添付合計 {2} MB" -f $n, $withAtt, [math]::Round($bytes/1MB,1))
if ($oldest) { Write-Output ("期間: {0:yyyy/MM/dd} 〜 {1:yyyy/MM/dd}" -f $oldest, $newest) }
Write-Output ""
Write-Output "=== 添付の拡張子 ==="
$ext.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 12 |
  ForEach-Object { Write-Output ("  {0,-10} {1}" -f $_.Key, $_.Value) }
Write-Output ""
Write-Output "=== 送信元ドメイン 上位 ==="
$senders.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 12 |
  ForEach-Object { Write-Output ("  {0,6}  {1}" -f $_.Value, $_.Key) }


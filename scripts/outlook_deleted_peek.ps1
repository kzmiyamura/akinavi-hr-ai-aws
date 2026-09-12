# 削除済みアイテムの中身を数件だけ見る（読み取りのみ）。
#
# poll-email は処理後に Graph の DELETE を呼んでいる。DELETE が本当に
# 「削除済みアイテム」へ移しているなら、そこには処理済みの人材メールが並ぶはず。
# 並んでいないなら、DELETE が完全削除になっているか、Outlook がこのフォルダを
# 同期していないかのどちらか。中身を見れば切り分けられる。

$olFolderDeletedItems = 3
$Take = if ($args.Count -ge 1) { [int]$args[0] } else { 10 }

$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")

foreach ($store in $ns.Stores) {
  $f = $null
  try { $f = $store.GetDefaultFolder($olFolderDeletedItems) } catch { continue }
  Write-Output ("=== {0} / 削除済みアイテム（{1} 件）===" -f $store.DisplayName, $f.Items.Count)
  $items = $f.Items
  try { $items.Sort("[ReceivedTime]", $true) } catch { }
  $i = 0
  foreach ($m in $items) {
    if ($m.Class -ne 43) { continue }
    $i++
    if ($i -gt $Take) { break }
    $from = ""
    try { $from = $m.SenderEmailAddress } catch { }
    $att = 0
    try { $att = $m.Attachments.Count } catch { }
    $read = ""
    try { $read = if ($m.UnRead) { "未読" } else { "既読" } } catch { }
    Write-Output ("  {0:yyyy/MM/dd HH:mm}  {1}  添付{2}  {3}" -f $m.ReceivedTime, $read, $att, $from)
    Write-Output ("      件名: {0}" -f $m.Subject)
  }
  if ($i -eq 0) { Write-Output "  （メールなし）" }
  Write-Output ""
}


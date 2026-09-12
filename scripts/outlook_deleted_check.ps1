# 削除済みアイテムに処理済みメールが残っているかを、ストアごとに正しく数える（読み取りのみ）。
#
# フォルダ名を総当たりで探す方法だと、キャッシュの同期状況や名前の違いで取りこぼす。
# Store.GetDefaultFolder で「そのアカウントの削除済みアイテム」を直に取る。
#
# poll-email には削除済みから読み直す復旧モードがあるので、本来は残っているはず。
# 残っていないなら、Outlook のキャッシュが持っていないのか、サーバー側で消えているのかを
# 切り分ける必要がある（キャッシュ設定も出す）。

$olFolderDeletedItems = 3
$olFolderInbox        = 6
$olFolderJunk         = 23

$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")

foreach ($store in $ns.Stores) {
  Write-Output ("=== {0} ===" -f $store.DisplayName)
  Write-Output ("  種別: {0} / キャッシュ: {1}" -f $store.ExchangeStoreType, $store.IsCachedExchange)
  foreach ($pair in @(@($olFolderInbox,'受信トレイ'), @($olFolderJunk,'迷惑メール'), @($olFolderDeletedItems,'削除済みアイテム'))) {
    $id = $pair[0]; $label = $pair[1]
    try {
      $f = $store.GetDefaultFolder($id)
    } catch {
      Write-Output ("  {0,-16} 取得できません" -f $label)
      continue
    }
    $items = $f.Items
    $count = $items.Count
    $oldest = $null; $newest = $null; $mails = 0
    foreach ($m in $items) {
      if ($m.Class -ne 43) { continue }
      $mails++
      $rt = $m.ReceivedTime
      if (-not $newest -or $rt -gt $newest) { $newest = $rt }
      if (-not $oldest -or $rt -lt $oldest) { $oldest = $rt }
    }
    $range = if ($oldest) { "{0:yyyy/MM/dd} 〜 {1:yyyy/MM/dd}" -f $oldest, $newest } else { "-" }
    Write-Output ("  {0,-16} 全 {1,6} 件 / メール {2,6} 件 / {3}" -f $label, $count, $mails, $range)
  }
  Write-Output ""
}


# Outlook からメールを原本ごとローカルへ吸い出す（読み取り専用・egress ゼロ）。
#
# なぜ要るか:
#   poll-email は処理後にメールを削除する（=削除済みアイテムへ移動）。Outlook 側が
#   それを自動で消すため、**1日未満で原本が失われる**（9/11 の 2,337 通は既に消えていた）。
#   Supabase の raw/ も保持1日なので、どちらも「後から再解析する」用途では機能していない。
#   ここで原本を確保すれば、raw/ そのものが不要になる。
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File scripts\outlook_export.ps1 `
#       -Folders "akinavi.hr.ai.voice.human@outlook.jp\削除済みアイテム" -Dest "D:\akinavi-archive\mail"
#   -Limit 3 -DryRun  … 試すとき
#
# 出力:
#   <Dest>\<yyyy-MM-dd>\<メッセージID>\message.msg   正本（Outlook に戻せる）
#                                      \message.json  件名・差出人・本文（grep 用）
#                                      \att01_名簿.xlsx …  添付を元の名前で展開
#
# 既読状態は変えない。受信トレイのメールを既読にすると poll-email が拾わなくなるため、
# 取り出し後に元の状態へ必ず戻す（変わっていたときだけ書き戻す）。

param(
  [string[]]$Folders = @(),
  [string]$Dest = "D:\akinavi-archive\mail",
  [int]$Limit = 0,
  [switch]$DryRun
)

if ($Folders.Count -eq 0) {
  Write-Output '使い方: -Folders "<ストア>\<フォルダ>" [-Dest <保存先>] [-Limit N] [-DryRun]'
  exit 1
}

# powershell.exe -File 経由だと配列がカンマ連結の1要素になって渡る。
# タスクスケジューラからもこの形で呼ぶので、ここで必ず割り直す
$Folders = @($Folders | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

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

# ファイル名に使えない文字を落とす。長すぎるパスは Windows で書けないので詰める
function Sanitize([string]$s, [int]$max) {
  if (-not $s) { return "unknown" }
  $out = $s -replace '[\\/:*?"<>|]', '_'
  $out = $out -replace '[\x00-\x1f]', ''
  $out = $out.Trim()
  if ($out.Length -gt $max) { $out = $out.Substring(0, $max) }
  if (-not $out) { return "unknown" }
  return $out
}

if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest -Force | Out-Null }
$indexPath = Join-Path $Dest "_exported.txt"
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
if (Test-Path $indexPath) {
  foreach ($line in Get-Content $indexPath -Encoding utf8) { if ($line) { $null = $seen.Add($line) } }
}

$totalNew = 0
$totalSkip = 0
$totalAtt = 0
$newIds = New-Object System.Collections.ArrayList

foreach ($fpath in $Folders) {
  $folder = Find-Folder $fpath
  if (-not $folder) { Write-Output "フォルダが見つかりません: $fpath"; continue }
  $items = $folder.Items
  try { $items.Sort("[ReceivedTime]", $true) } catch { }

  $n = 0
  foreach ($m in $items) {
    if ($m.Class -ne 43) { continue }
    if ($Limit -gt 0 -and $n -ge $Limit) { break }

    # 同じメールを二度書かないための鍵。Message-ID が取れなければ EntryID
    $mid = ""
    try { $mid = $m.PropertyAccessor.GetProperty("http://schemas.microsoft.com/mapi/proptag/0x1035001F") } catch { }
    if (-not $mid) { try { $mid = $m.EntryID } catch { } }
    $key = Sanitize ($mid -replace '[<>]', '') 80
    if ($seen.Contains($key)) { $totalSkip++; continue }

    $n++
    $day = "{0:yyyy-MM-dd}" -f $m.ReceivedTime
    $dir = Join-Path (Join-Path $Dest $day) $key

    if ($DryRun) {
      Write-Output ("  [dry] {0:yyyy/MM/dd HH:mm} 添付{1} {2}" -f $m.ReceivedTime, $m.Attachments.Count, $m.Subject)
      $totalNew++
      continue
    }

    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    # 既読状態を控えておく（取り出しで変わったら戻す）
    $wasUnread = $false
    try { $wasUnread = $m.UnRead } catch { }

    try {
      $m.SaveAs((Join-Path $dir "message.msg"), 3)   # 3 = olMSG
    } catch {
      Write-Output ("  msg 保存に失敗: {0}" -f $_.Exception.Message)
    }

    $attList = New-Object System.Collections.ArrayList
    $i = 0
    foreach ($a in $m.Attachments) {
      $i++
      try {
        $name = Sanitize $a.FileName 80
        $file = "{0:00}_{1}" -f $i, $name
        $a.SaveAsFile((Join-Path $dir $file))
        $null = $attList.Add(@{ file = $file; original = $a.FileName; size = $a.Size })
        $totalAtt++
      } catch {
        Write-Output ("  添付の保存に失敗: {0}" -f $_.Exception.Message)
      }
    }

    $sender = ""
    try { $sender = $m.SenderEmailAddress } catch { }
    $body = ""
    try { $body = $m.Body } catch { }

    $meta = [ordered]@{
      messageId    = $mid
      subject      = $m.Subject
      from         = $sender
      senderName   = $m.SenderName
      receivedTime = "{0:yyyy-MM-ddTHH:mm:ss}" -f $m.ReceivedTime
      folder       = $fpath
      size         = $m.Size
      attachments  = $attList
      body         = $body
    }
    # JSON は BOM 付きで書かれる。読む側（Node）で先頭の BOM を落とすこと
    ($meta | ConvertTo-Json -Depth 5) | Out-File (Join-Path $dir "message.json") -Encoding utf8

    # 既読状態が変わっていたら戻す。受信トレイのメールを既読にすると
    # poll-email（isRead eq false で拾う）が取りこぼす
    try {
      if ($m.UnRead -ne $wasUnread) { $m.UnRead = $wasUnread; $m.Save() }
    } catch { }

    $null = $seen.Add($key)
    $null = $newIds.Add($key)
    $totalNew++
  }
  Write-Output ("{0,-50} 新規 {1} 件" -f $fpath, $n)
}

if (-not $DryRun -and $newIds.Count -gt 0) {
  $newIds | Out-File $indexPath -Encoding utf8 -Append
}

Write-Output ""
Write-Output ("新規 {0} 件 / 取得済みのため省略 {1} 件 / 添付 {2} 件" -f $totalNew, $totalSkip, $totalAtt)
Write-Output ("保存先: {0}" -f $Dest)

# 毎回の状況を1行ずつ記録する。目的は2つ:
#   1. 削除済みフォルダが「何分で空になるか」を実測して、回収間隔を当て推量でなく決める
#      （いちばん古いメールが何分前のものかを見れば、保持時間の下限が分かる）
#   2. 長時間ゼロが続いたら異常と気づける（pm2 が黙って死んだ前例がある）
try {
  $delCount = 0
  $oldestRecv = -1
  $oldestMoved = -1
  foreach ($store in $ns.Stores) {
    if ($store.DisplayName -notlike "akinavi*") { continue }
    $df = $store.GetDefaultFolder(3)
    $delCount = $df.Items.Count
    foreach ($m in $df.Items) {
      if ($m.Class -ne 43) { continue }
      $r = [int]((Get-Date) - $m.ReceivedTime).TotalMinutes
      if ($r -gt $oldestRecv) { $oldestRecv = $r }
      # 削除済みへ移された時刻の近似。受信時刻ではこれが測れない
      # （朝届いて夕方処理されたメールは「何時間も前」に見えてしまう）。
      # 知りたいのは「削除済みに入ってから何分生き延びるか」なので LastModificationTime を見る
      try {
        $mv = [int]((Get-Date) - $m.LastModificationTime).TotalMinutes
        if ($mv -gt $oldestMoved) { $oldestMoved = $mv }
      } catch { }
    }
  }
  $line = "{0:yyyy-MM-dd HH:mm},{1},{2},{3},{4},{5},{6}" -f (Get-Date), $totalNew, $totalSkip, $totalAtt, $delCount, $oldestMoved, $oldestRecv
  $logPath = Join-Path $Dest "_runs.csv"
  if (-not (Test-Path $logPath)) {
    "日時,新規,省略,添付,削除済み件数,移動からの最古(分),受信からの最古(分)" | Out-File $logPath -Encoding utf8
  }
  $line | Out-File $logPath -Encoding utf8 -Append
  Write-Output ("削除済み {0} 件 / 移動から最長 {1} 分 生き延びている（この値が回収間隔の上限）" -f $delCount, $oldestMoved)
} catch {
  Write-Output ("実行記録の書き込みに失敗: {0}" -f $_.Exception.Message)
}





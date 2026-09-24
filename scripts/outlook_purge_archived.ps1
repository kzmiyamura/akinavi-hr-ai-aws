# outlook_purge_archived.ps1 — 控えに取り終えたメールだけを Outlook から消す（2026-09-24）
#
# ■ なぜ要るか
#   2026-06 に Outlook の保有メール数が上限に当たり、取り込みが止まった。
#   そのときは**人が手で消して復旧した**。
#   2026-09-12 に「原本を残すため完全削除をやめて削除済みアイテムへ移す」に変えた（d8fd877）。
#   そのとき「30日で Outlook が自動削除するから溢れない」と書いたが、
#   **これは仕様を読んだだけで一度も確認していない**。
#   実測（2026-09-24）: 削除済みアイテム 17,760件・最古 09/12・1日約1,480件増。
#   つまり自動削除はまだ一度も観測できていない。また手作業に戻る前に自動化する。
#
# ■ 安全の要
#   **控え（_exported.txt）に鍵がある分しか消さない。** 1件でも控えていないものは残す。
#   鍵の作り方は outlook_export.ps1 と完全に同じ（Message-ID → 無ければ EntryID → Sanitize 80）。
#   ずれると「控えたのに消せない」か「控えていないのに消す」のどちらかになる。
#
#   既定は DryRun（数えるだけ）。実際に消すには -Execute を明示する。
#   削除済みアイテムからの Delete() は**完全削除**で戻せない。だから既定を安全側にしてある。
#
# ■ 使い方
#   # まず数える（何も消さない）
#   powershell -ExecutionPolicy Bypass -File scripts\outlook_purge_archived.ps1
#
#   # 控え済みのものを最大2000件消す（既定: 受信から1日より古いもの）
#   powershell -ExecutionPolicy Bypass -File scripts\outlook_purge_archived.ps1 -Execute
#
#   # 控えのファイル実体まで確認してから消す（遅いが確実）
#   powershell -ExecutionPolicy Bypass -File scripts\outlook_purge_archived.ps1 -Execute -VerifyFiles
#
# ■ 打ち切っても安全
#   1回の上限（-Limit）で止まっても、次回は残りから再開する（消した分は消えているだけ）。

param(
  [string]$Folder = "akinavi.hr.ai.voice.human@outlook.jp\削除済みアイテム",
  [string]$Dest = "D:\akinavi-archive\mail",
  # これより新しいものは消さない。
  # ⚠ 「念のため長めに」は無意味。削除済みアイテムには **poll-email が処理し終えたものしか
  #    入らない**（処理後に move している）。そこに控えもあるなら残す理由はゼロ。
  #    この日数は「控えを取る処理と競合しないための緩衝」でしかなく、
  #    控えは15分おきに走っているので1日で十二分（最初 14 にしていたのは根拠のない緩衝だった）。
  [int]$KeepDays = 1,
  [int]$Limit = 2000,      # 1回で消す上限。Outlook が固まらないよう小分けにする
  [switch]$Execute,        # 付けたときだけ実際に消す
  [switch]$VerifyFiles     # 控えの message.json の実在まで確認する
)

$ErrorActionPreference = 'Stop'

# ── 控え取得の最中なら動かない ──────────────────────────────────
# AkiNavi-MailExport は15分おきに走る。まだ控えていないメールを
# 「索引に無い」として残すのは安全側だが、走査中に消されると取りこぼす。
# 素直に譲って次回に回す（消し残しても次の回で片付く）。
try {
  $exportTask = Get-ScheduledTask -TaskName "AkiNavi-MailExport" -ErrorAction SilentlyContinue
  if ($exportTask -and $exportTask.State -eq 'Running') {
    Write-Output "控え取得（AkiNavi-MailExport）が実行中のため、今回は何もしません。"
    exit 0
  }
} catch { }

# ── 控えの鍵を読む ──────────────────────────────────────────────
$indexPath = Join-Path $Dest "_exported.txt"
if (-not (Test-Path $indexPath)) {
  Write-Output "控えの索引が見つかりません: $indexPath"
  Write-Output "先に outlook_export.ps1 を回してください。索引が無い状態では1件も消しません。"
  exit 1
}
$archived = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($line in Get-Content $indexPath -Encoding utf8) { if ($line) { $null = $archived.Add($line) } }
Write-Output ("控え済みの鍵: {0} 件" -f $archived.Count)

if ($archived.Count -eq 0) { Write-Output "索引が空です。中止します。"; exit 1 }

# ── 鍵の作り方は outlook_export.ps1 と同じにすること ────────────
function Sanitize([string]$s, [int]$max) {
  if (-not $s) { return "unknown" }
  $out = $s -replace '[\\/:*?"<>|]', '_'
  $out = $out.Trim()
  if ($out.Length -gt $max) { $out = $out.Substring(0, $max) }
  if (-not $out) { return "unknown" }
  return $out
}

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

$f = Find-Folder $Folder
if (-not $f) { Write-Output "フォルダが見つかりません: $Folder"; exit 1 }

$cutoff = (Get-Date).AddDays(-$KeepDays)
Write-Output ("対象: {0}（{1} 件）" -f $Folder, $f.Items.Count)
Write-Output ("条件: {0:yyyy/MM/dd} より古く、かつ控え済み / 1回の上限 {1} 件" -f $cutoff, $Limit)
Write-Output ("動作: {0}" -f $(if ($Execute) { "★実際に削除する（完全削除・戻せない）" } else { "数えるだけ（消さない）" }))
Write-Output ""

# 古い順に見る。消す対象は古い方から片付けたい
$items = $f.Items
try { $items.Sort("[ReceivedTime]", $false) } catch { }

$scanned = 0; $tooNew = 0; $notArchived = 0; $deleted = 0; $failed = 0
$notArchivedSample = New-Object System.Collections.ArrayList

# 削除するとコレクションが変わるので、先に対象を集めてから消す
$targets = New-Object System.Collections.ArrayList
foreach ($m in $items) {
  if ($m.Class -ne 43) { continue }
  $scanned++
  if ($m.ReceivedTime -ge $cutoff) { $tooNew++; continue }

  $mid = ""
  try { $mid = $m.PropertyAccessor.GetProperty("http://schemas.microsoft.com/mapi/proptag/0x1035001F") } catch { }
  if (-not $mid) { try { $mid = $m.EntryID } catch { } }
  $key = Sanitize ($mid -replace '[<>]', '') 80

  if (-not $archived.Contains($key)) {
    $notArchived++
    if ($notArchivedSample.Count -lt 5) {
      $null = $notArchivedSample.Add(("{0:MM/dd HH:mm} {1}" -f $m.ReceivedTime, $m.Subject))
    }
    continue
  }

  # 索引にあるだけでなく、実体（message.json）まで確認する
  if ($VerifyFiles) {
    $day = "{0:yyyy-MM-dd}" -f $m.ReceivedTime
    $mj = Join-Path (Join-Path (Join-Path $Dest $day) $key) "message.json"
    if (-not (Test-Path $mj)) { $notArchived++; continue }
  }

  $null = $targets.Add($m)
  if ($targets.Count -ge $Limit) { break }
}

Write-Output ("走査 {0} 件 / 新しくて対象外 {1} 件 / 控えに無いので残す {2} 件 / 削除対象 {3} 件" -f `
  $scanned, $tooNew, $notArchived, $targets.Count)

if ($notArchivedSample.Count -gt 0) {
  Write-Output ""
  Write-Output "控えに無いため残すもの（例）:"
  foreach ($s in $notArchivedSample) { Write-Output ("  " + $s) }
}

if (-not $Execute) {
  Write-Output ""
  Write-Output "数えただけです。実際に消すには -Execute を付けてください。"
  exit 0
}

foreach ($m in $targets) {
  try { $m.Delete(); $deleted++ } catch { $failed++ }
}

Write-Output ""
Write-Output ("削除 {0} 件 / 失敗 {1} 件 / 残り {2} 件" -f $deleted, $failed, $f.Items.Count)

# 実行記録。何回目で何件消えたかを後から追えるようにする
try {
  $logPath = Join-Path $Dest "_purge.csv"
  if (-not (Test-Path $logPath)) {
    "日時,走査,新しくて対象外,控えに無い,削除,失敗,残り" | Out-File $logPath -Encoding utf8
  }
  ("{0:yyyy-MM-dd HH:mm},{1},{2},{3},{4},{5},{6}" -f (Get-Date), $scanned, $tooNew, $notArchived, $deleted, $failed, $f.Items.Count) |
    Out-File $logPath -Encoding utf8 -Append
} catch { }




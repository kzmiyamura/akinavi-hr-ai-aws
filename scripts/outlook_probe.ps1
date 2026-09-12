# Outlook から直接メールを読めるかを確認する（読み取りのみ・何も書き換えない）。
#
# Supabase Storage の保持は raw 1日 / resumes 7日しかないが、メールボックスには
# 原本が残っている。そこから直接取れば **egress はゼロ**で、しかも過去ぶんが全部ある。
# まずアカウントとフォルダ、件数、添付の有無だけを数える。
#
# 使い方: powershell -ExecutionPolicy Bypass -File scripts\outlook_probe.ps1 [日数]

$Days = if ($args.Count -ge 1) { [int]$args[0] } else { 30 }

try {
  $ol = New-Object -ComObject Outlook.Application
} catch {
  Write-Output "Outlook に接続できません: $($_.Exception.Message)"
  Write-Output "Outlook が起動しているか、32/64bit が一致しているか確認してください。"
  exit 1
}

$ns = $ol.GetNamespace("MAPI")

Write-Output "=== アカウント ==="
foreach ($acc in $ns.Accounts) {
  Write-Output ("  {0}  ({1})" -f $acc.DisplayName, $acc.SmtpAddress)
}

Write-Output ""
Write-Output "=== 受信トレイ配下のフォルダ ==="
$inbox = $ns.GetDefaultFolder(6)  # olFolderInbox
Write-Output ("  {0}  {1} 件" -f $inbox.Name, $inbox.Items.Count)
foreach ($f in $inbox.Folders) {
  Write-Output ("    └ {0}  {1} 件" -f $f.Name, $f.Items.Count)
}

# 直近N日で、添付のあるメールを数える。
# Restrict は DASL より SQL 風のほうが速いが、ここは件数把握だけなので素直に絞る
$since = (Get-Date).AddDays(-$Days).ToString("MM/dd/yyyy HH:mm")
$filter = "[ReceivedTime] >= '$since'"

function Measure-Folder($folder, $label) {
  try { $items = $folder.Items.Restrict($filter) } catch { return }
  $n = 0; $withAtt = 0; $xls = 0; $doc = 0; $bytes = 0
  foreach ($m in $items) {
    if ($m.Class -ne 43) { continue }   # olMail 以外は数えない
    $n++
    if ($m.Attachments.Count -gt 0) {
      $withAtt++
      foreach ($a in $m.Attachments) {
        $bytes += $a.Size
        if ($a.FileName -match '\.(xlsx?|xlsm)$') { $xls++ }
        if ($a.FileName -match '\.(docx?|pdf)$')  { $doc++ }
      }
    }
  }
  Write-Output ("  {0,-24} メール {1,6} 件 / 添付あり {2,5} 件 / Excel {3,4} / Word・PDF {4,4} / 合計 {5} MB" -f
    $label, $n, $withAtt, $xls, $doc, [math]::Round($bytes/1MB,1))
}

Write-Output ""
Write-Output "=== 直近 $Days 日 ==="
Measure-Folder $inbox "受信トレイ"
foreach ($f in $inbox.Folders) { Measure-Folder $f $f.Name }


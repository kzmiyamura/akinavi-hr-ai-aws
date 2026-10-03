# register_selfcheck_task.ps1 — 夜間健診を毎日のタスクとして登録する
#
# `scripts/selfcheck_daily.cmd` を 04:40 に回す。既存のタスクに合わせた時刻:
#   03:30 AkiNavi-ArchiveLocal   本番の控えを増分で取る
#   04:10 AkiNavi-QualityTruth   品質の実測
#   04:40 AkinaviSelfcheck       ← これ（控えとリポジトリのソースだけを読む）
#
# ⚠ 健診は **Claude を呼ばない**。egress もトークンも使わない。
#   所見が出たら `%USERPROFILE%\akinavi_selfcheck_NEW.txt` が残るだけ。
#
# 使い方: powershell -File scripts/register_selfcheck_task.ps1
#         powershell -File scripts/register_selfcheck_task.ps1 -Unregister
param([switch]$Unregister)

$name = 'AkinaviSelfcheck'
$cmd = Join-Path $PSScriptRoot 'selfcheck_daily.cmd'

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Output "$name を削除しました"
  exit 0
}

if (-not (Test-Path $cmd)) { Write-Error "見つかりません: $cmd"; exit 1 }
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Write-Output "$name は既に登録済み。作り直します"
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}

$act = New-ScheduledTaskAction -Execute $cmd
$trg = New-ScheduledTaskTrigger -Daily -At '04:40'
$prn = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
# StartWhenAvailable: PCが寝ていて流れなかった日は、起きた後に1回だけ流す。
# 30分で打ち切る（健診は実測で1分未満。長引いたら何かが壊れている）
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $name -Action $act -Trigger $trg -Principal $prn -Settings $set `
  -Description '夜間健診。ローカル控えとリポジトリのソースだけを読む（egress・トークンゼロ）。所見があれば akinavi_selfcheck_NEW.txt を残す' | Out-Null

Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-Table -AutoSize
Write-Output ''
Write-Output '動作確認（すぐ1回流す）: Start-ScheduledTask -TaskName AkinaviSelfcheck'
Write-Output ('ログ: ' + $env:USERPROFILE + '\akinavi_selfcheck.log')

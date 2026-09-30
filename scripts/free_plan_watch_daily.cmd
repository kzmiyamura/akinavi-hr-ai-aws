@echo off
rem ---------------------------------------------------------------------------
rem free_plan_watch_daily.cmd - run the Free plan watch once a day
rem   Registered in Task Scheduler as "AkinaviFreePlanWatch" (daily 09:00).
rem   Deliberately NOT under pm2: the pm2 daemon has died silently before.
rem
rem   log   : %USERPROFILE%\akinavi_free_plan_watch.log   (always appended)
rem   alert : %USERPROFILE%\akinavi_free_plan_ALERT.txt   (only while over 70%%,
rem           removed automatically once back under the threshold)
rem ---------------------------------------------------------------------------
setlocal
cd /d "C:\Users\admin\Desktop\projects\akinavi-hr-ai-aws"

set "LOG=%USERPROFILE%\akinavi_free_plan_watch.log"
set "ALERT=%USERPROFILE%\akinavi_free_plan_ALERT.txt"
set "TMPOUT=%TEMP%\akinavi_free_plan_watch.out"
set "NODE_NO_WARNINGS=1"

rem Default to --mail. The scheduled task registers this file with no arguments,
rem so the mail behaviour has to live here rather than in the task definition.
rem --mail sends only when over 70%%, plus one weekly digest on Mondays.
set "ARGS=%*"
if "%~1"=="" set "ARGS=--mail"

node scripts\free_plan_watch.mjs %ARGS% > "%TMPOUT%" 2>&1
set RC=%ERRORLEVEL%

echo. >> "%LOG%"
echo ==== %DATE% %TIME%  (exit=%RC%) ==== >> "%LOG%"
type "%TMPOUT%" >> "%LOG%"

if %RC% GEQ 1 (
  copy /y "%TMPOUT%" "%ALERT%" >nul
) else (
  if exist "%ALERT%" del "%ALERT%"
)
endlocal

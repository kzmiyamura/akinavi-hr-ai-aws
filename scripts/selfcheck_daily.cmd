@echo off
rem ---------------------------------------------------------------------------
rem selfcheck_daily.cmd - run the nightly self-check once a day
rem   Register in Task Scheduler as "AkinaviSelfcheck" (daily, AFTER the archive
rem   refresh - the detectors read the local archive, not production).
rem
rem   Reads ONLY the local archive and the repo source: zero egress, zero tokens.
rem   Claude is never invoked from here. Exit 1 just leaves a file behind.
rem
rem   log      : %USERPROFILE%\akinavi_selfcheck.log        (always appended)
rem   new      : %USERPROFILE%\akinavi_selfcheck_NEW.txt    (only while new findings exist)
rem   machine  : %USERPROFILE%\akinavi_selfcheck_fresh.json (for the fix step)
rem
rem   exit 0 = no new findings / 1 = new findings / 2 = a detector crashed
rem   Exit 2 is the worst case: zero findings then means the check itself is broken.
rem ---------------------------------------------------------------------------
setlocal
cd /d "C:\Users\admin\Desktop\projects\akinavi-hr-ai-aws"

set "LOG=%USERPROFILE%\akinavi_selfcheck.log"
set "NEW=%USERPROFILE%\akinavi_selfcheck_NEW.txt"
set "FRESH=%USERPROFILE%\akinavi_selfcheck_fresh.json"
set "TMPOUT=%TEMP%\akinavi_selfcheck.out"
set "NODE_NO_WARNINGS=1"

rem Refresh the local archive first. Without it the data-side detectors judge
rem yesterday's rows. This is the only step that touches production, and it is
rem incremental (cursor-based), so it costs what it always costs.
if /i not "%~1"=="--no-archive" (
  node scripts\archive_local.mjs >> "%LOG%" 2>&1
)

node scripts\selfcheck\run.mjs > "%TMPOUT%" 2>&1
set RC=%ERRORLEVEL%

rem Machine-readable copy for the (manual) fix step. Kept separate so the
rem human-readable log stays readable.
node scripts\selfcheck\run.mjs --json > "%FRESH%" 2>nul

echo. >> "%LOG%"
echo ==== %DATE% %TIME%  (exit=%RC%) ==== >> "%LOG%"
type "%TMPOUT%" >> "%LOG%"

if %RC% GEQ 1 (
  copy /y "%TMPOUT%" "%NEW%" >nul
  echo. >> "%NEW%"
  echo -- If a finding is not a bug, silence it WITH A REASON: >> "%NEW%"
  echo --   node scripts/selfcheck/run.mjs --accept "why this is fine" >> "%NEW%"
) else (
  if exist "%NEW%" del "%NEW%"
)
endlocal

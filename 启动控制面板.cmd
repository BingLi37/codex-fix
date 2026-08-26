@echo off
REM Opens the dashboard. Starts the control panel first if it is not already up.
chcp 65001 >nul
setlocal

set "HERE=%~dp0"
set "PANEL_URL=http://127.0.0.1:7800"

REM Is the panel already listening? Autostart may have started it at logon.
netstat -ano | findstr /C:"127.0.0.1:7800" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Panel already running, opening page...
  start "" "%PANEL_URL%"
  exit /b 0
)

if not exist "%HERE%ui\dist\index.html" (
  echo UI not built yet, falling back to the simple dashboard.
  echo To build it: cd ui ^&^& npm install ^&^& npm run build
  echo.
)

REM Launch through the .vbs so no console window is left sitting open.
echo Starting control panel...
wscript.exe "%HERE%autostart-hidden.vbs"

REM Wait until it answers. ping is used as the delay because timeout.exe needs
REM a console stdin and fails when this script is run from another shell.
set /a tries=0
:wait
set /a tries+=1
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr /C:"127.0.0.1:7800" | findstr /C:"LISTENING" >nul 2>&1
if errorlevel 1 (
  if %tries% lss 15 goto wait
  echo Failed to start. See logs\panel-stdout.log
  ping -n 9 127.0.0.1 >nul
  exit /b 1
)

start "" "%PANEL_URL%"
echo.
echo Control panel: %PANEL_URL%
ping -n 4 127.0.0.1 >nul

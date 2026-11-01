@echo off
setlocal
chcp 65001 >nul
title Star Dream Launcher
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-node.ps1"
if errorlevel 1 goto failnode

rem Prefer the portable Node installed by ensure-node.ps1; bypass a stale PATH.
if exist "%~dp0runtime\node\node.exe" goto uselocal
if exist "%~dp0runtime\node-dir.txt" set /p NODE_DIR=<"%~dp0runtime\node-dir.txt"
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
set "NODE_EXE=node"
goto run

:uselocal
set "PATH=%~dp0runtime\node;%PATH%"
set "NODE_EXE=%~dp0runtime\node\node.exe"

:run
"%NODE_EXE%" bootstrap.js
echo.
pause
exit /b 0

:failnode
echo.
echo   Node.js installation failed.
echo   Check your network and try again, or install Node.js 22.5+ manually:
echo   https://nodejs.org/en/download
echo.
pause
exit /b 1

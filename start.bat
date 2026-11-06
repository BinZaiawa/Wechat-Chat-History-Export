@echo off
title WeChat Chat Export Tool
cd /d "%~dp0"
setlocal

echo.
echo   ==========================================
echo    WeChat Chat Export Tool
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

for /f "tokens=*" %%i in ('node -v') do set NODEVER=%%i
echo   Node.js : %NODEVER%
echo   Starting server, browser will open automatically...
echo.

node "%~dp0wxextract\server.js" %*
set RC=%ERRORLEVEL%

echo.
echo   Server stopped (exit code %RC%)
echo.
pause
exit /b %RC%

:NONODE
echo   [ERROR] Node.js not found on PATH.
echo   Please install Node.js 22 or newer from https://nodejs.org/
echo.
pause
exit /b 1
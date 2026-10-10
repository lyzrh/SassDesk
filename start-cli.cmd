@echo off
chcp 65001 >nul
title SassDesk - CLI
cd /d %~dp0
echo Starting SassDesk CLI...
echo.
node dist\index.js
pause

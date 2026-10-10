@echo off
chcp 65001 >nul
title SassDesk Desktop - Sass
cd /d %~dp0
echo Starting Sass desktop pet (tray icon at bottom-right)...
node_modules\.bin\electron.cmd dist\desktop\main.mjs

@echo off
chcp 65001 >nul
title Bingda Updater
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" -Setup
set "bingda_exit=%errorlevel%"
pause
exit /b %bingda_exit%

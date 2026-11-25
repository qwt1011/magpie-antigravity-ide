@echo off
powershell.exe -NoProfile -File "%~dp0start-ide-proxy.ps1" %*
if errorlevel 1 pause

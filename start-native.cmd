@echo off
powershell.exe -NoProfile -File "%~dp0start-native.ps1" %*
if errorlevel 1 pause

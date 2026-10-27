@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcut.ps1"
rem Wait somewhere else, so this window never keeps the app folder in use
cd /d "%TEMP%"
pause

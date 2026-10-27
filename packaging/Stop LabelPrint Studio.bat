@echo off
rem Stops every running part of LabelPrint Studio (server and app window, also of other copies or older versions),
rem for example before moving or deleting the app folder
"%~dp0python\python.exe" "%~dp0run.py" --stop
pause

@echo off
REM Launched by Chrome/Brave via native messaging on Windows. Equivalent of
REM run_native_host.sh: execs the venv's python directly against native_host.py.
REM stdin/stdout carry the framed messages, so all diagnostics go to the log file.
set "LOG=%LOCALAPPDATA%\erp-auto-login\host.log"
if not exist "%LOCALAPPDATA%\erp-auto-login" mkdir "%LOCALAPPDATA%\erp-auto-login"
echo === %date% %time% started === >> "%LOG%"
"%~dp0..\.venv\Scripts\python.exe" "%~dp0native_host.py" 2>> "%LOG%"

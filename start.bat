@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (set "ZA_PY=python") else (set "ZA_PY=py -3")
if not exist ".venv\Scripts\python.exe" (
  %ZA_PY% -m venv .venv
  if errorlevel 1 goto fail
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto fail
".venv\Scripts\python.exe" bridge.py %*
pause
exit /b
:fail
echo Setup failed. Install Python 3.10 or newer from python.org, then try again.
pause
exit /b 1

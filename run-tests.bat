@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (set "ZA_TEST_PY=.venv\Scripts\python.exe") else (set "ZA_TEST_PY=python")
%ZA_TEST_PY% -m unittest discover -s tests -v
if errorlevel 1 exit /b 1
for %%f in (test-parser test-chatgpt test-popup test-worker test-approval test-loop) do (
  node extension/%%f.js
  if errorlevel 1 exit /b 1
)

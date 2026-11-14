@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
if not exist ".venv\Scripts\python.exe" (
  echo [ThinkPaper] creating virtual environment...
  python -m venv .venv || goto :fail
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail
)
".venv\Scripts\python.exe" server.py --open %*
pause
exit /b

:fail
echo [ThinkPaper] setup failed. Make sure Python 3.10+ is installed and on PATH.
pause

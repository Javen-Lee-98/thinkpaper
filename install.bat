@echo off
rem ThinkPaper one-step install (Windows only). Double-click it.
rem Finds Python 3.10+ and runs inkthink\tools\install.py; arguments are passed on (e.g. install.bat --dry-run).
setlocal
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PY="
py -3 -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul && set "PY=python"
if defined PY %PY% "%~dp0inkthink\tools\install.py" %*
set "RC=%ERRORLEVEL%"
if not defined PY set "RC=1"
if not defined PY echo Python 3.10 or newer was not found. Install it from https://www.python.org/downloads/
if not defined PY echo and tick "Add python.exe to PATH" during setup, then double-click install.bat again.
if "%~1"=="" pause
exit /b %RC%

@echo off
:: ============================================================
::  setup_windows.bat — One-time setup for Daraz Daily Agent
::  Run as Administrator for Task Scheduler registration
::  Double-click or: Right-click → "Run as administrator"
:: ============================================================

setlocal enabledelayedexpansion

:: ── Get the folder where this script lives ───────────────────
set "AGENT_DIR=%~dp0"
:: Remove trailing backslash
if "%AGENT_DIR:~-1%"=="\" set "AGENT_DIR=%AGENT_DIR:~0,-1%"

echo.
echo  =====================================================
echo   Daraz Daily Agent — Windows Setup
echo  =====================================================
echo.

:: ── Check Python ─────────────────────────────────────────────
where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Download from https://python.org
    pause
    exit /b 1
)
echo [OK] Python found

:: ── Install dependencies ─────────────────────────────────────
echo.
echo  Installing Python dependencies...
python -m pip install -r "%AGENT_DIR%\requirements.txt" --quiet
if errorlevel 1 (
    echo [ERROR] pip install failed. Check requirements.txt
    pause
    exit /b 1
)
echo [OK] Dependencies installed

:: ── Create .env if missing ───────────────────────────────────
if not exist "%AGENT_DIR%\.env" (
    copy "%AGENT_DIR%\.env.example" "%AGENT_DIR%\.env" >nul
    echo [OK] Created .env — please edit it with your OpenAI API key
) else (
    echo [OK] .env already exists
)

:: ── Create reports folder ────────────────────────────────────
if not exist "%AGENT_DIR%\reports" mkdir "%AGENT_DIR%\reports"
echo [OK] Reports folder ready: %AGENT_DIR%\reports

:: ── Register Windows Task Scheduler ──────────────────────────
echo.
echo  Registering Task Scheduler job (runs daily at 7:00 AM)...

set TASK_NAME=DarazDailyAgent
set PYTHON_PATH=python
set SCRIPT_PATH=%AGENT_DIR%\run_agent.py

:: Delete old task if exists (ignore error)
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: Create new task
schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%PYTHON_PATH%\" \"%SCRIPT_PATH%\"" ^
  /sc DAILY ^
  /st 07:00 ^
  /rl HIGHEST ^
  /f ^
  /sd %date% >nul

if errorlevel 1 (
    echo [WARN] Could not register task automatically.
    echo        Run this script as Administrator, or set it up manually.
    echo        See WINDOWS_SETUP.md for manual instructions.
) else (
    echo [OK] Task Scheduler job created: "%TASK_NAME%"
    echo      Runs every day at 7:00 AM
)

echo.
echo  =====================================================
echo   Setup complete!
echo.
echo   Next steps:
echo     1. Edit your API key:  notepad "%AGENT_DIR%\.env"
echo     2. Test it now:        python "%AGENT_DIR%\run_agent.py"
echo     3. Reports saved to:   %AGENT_DIR%\reports\
echo  =====================================================
echo.
pause

@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo       Mashawerr API - Git Auto Push
echo ==========================================

:: Check if there are changes
git status --porcelain > "%TEMP%\git_status.tmp"
for %%R in ("%TEMP%\git_status.tmp") do if %%~zR==0 (
    echo [INFO] No changes detected.
    del "%TEMP%\git_status.tmp"
    goto :EOF
)
del "%TEMP%\git_status.tmp"

:: Set commit message
set "MSG=%~1"
if "%MSG%"=="" (
    set "MSG=Auto update backend: %date% %time%"
)

echo [1/3] Adding changes...
git add -A

echo [2/3] Committing changes with message: "%MSG%"
git commit -m "%MSG%"

echo [3/3] Pushing to GitHub (origin main)...
git push origin main

if errorlevel 1 (
    echo [ERROR] Git push failed.
    exit /b 1
) else (
    echo ==========================================
    echo [SUCCESS] Backend pushed to GitHub successfully!
    echo ==========================================
)

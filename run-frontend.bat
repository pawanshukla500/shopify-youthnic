@echo off
setlocal
cd /d "%~dp0"
title Shopify OMS - admin panel (frontend)

echo ==================================================
echo   Shopify OMS - starting admin panel (frontend)
echo ==================================================
echo.

rem --- Node.js present? ---
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo Install Node.js 20 or newer from https://nodejs.org then run this again.
    goto :fail
)
for /f "delims=" %%v in ('node -v') do echo Node %%v

rem --- Frontend dependencies installed? ---
if not exist "frontend\node_modules" (
    echo.
    echo Installing frontend dependencies. This happens once and may take a few minutes...
    pushd frontend
    call npm install
    if errorlevel 1 (
        popd
        echo.
        echo [ERROR] npm install failed. Scroll up for the reason.
        goto :fail
    )
    popd
)

rem --- Port already taken? ---
netstat -ano | findstr ":5173" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo.
    echo [ERROR] Port 5173 is already in use, so the frontend cannot start.
    echo Another copy of the admin panel is probably still running.
    echo Close that window to free the port.
    goto :fail
)

echo.
echo The backend server (port 3000) must be running too.
echo Start it first with run.bat if it is not already up.
echo.
echo Admin panel: http://localhost:5173
echo.
echo Press Ctrl+C in this window to stop the panel.
echo.

pushd frontend
call npm run dev
popd

echo.
echo Admin panel stopped.
goto :end

:fail
echo.
echo Startup aborted. Fix the problem above and run this again.

:end
echo.
pause
endlocal

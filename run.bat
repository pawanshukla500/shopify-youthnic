@echo off
setlocal
cd /d "%~dp0"
title Shopify OMS - local server

echo ==================================================
echo   Shopify OMS - starting local server
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

rem --- Environment file present? ---
if not exist ".env" (
    echo.
    echo [ERROR] .env was not found in this folder.
    echo Copy .env.example to .env and fill in your values first.
    goto :fail
)

rem --- Dependencies installed? ---
if not exist "node_modules" (
    echo.
    echo Installing dependencies. This happens once and may take a few minutes...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. Scroll up for the reason.
        goto :fail
    )
)

rem --- Prisma client generated? ---
if not exist "node_modules\.prisma\client" (
    echo.
    echo Generating the Prisma database client...
    call npm run db:generate
    if errorlevel 1 (
        echo.
        echo [ERROR] Prisma client generation failed. Scroll up for the reason.
        goto :fail
    )
)

rem --- Port already taken? ---
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo.
    echo [ERROR] Port 3000 is already in use, so the server cannot start.
    echo Another copy of this app is probably still running.
    echo Close that window, or list the owner with:
    echo     netstat -ano ^| findstr :3000
    goto :fail
)

echo.
echo Server:       http://localhost:3000
echo Health check: http://localhost:3000/api/health
echo.
echo Press Ctrl+C in this window to stop the server.
echo.

call npm run dev

echo.
echo Server stopped.
goto :end

:fail
echo.
echo Startup aborted. Fix the problem above and run this again.

:end
echo.
pause
endlocal

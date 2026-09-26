@echo off
setlocal
cd /d "%~dp0"
title Shopify OMS - Launcher

echo ==================================================
echo   Shopify OMS - Starting Full Stack Environment
echo ==================================================
echo.

rem --- 1. Check Node.js ---
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo Install Node.js 20 or newer from https://nodejs.org then run this again.
    goto :fail
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v detected.

rem --- 2. Check .env file ---
if not exist ".env" (
    echo.
    if exist ".env.example" (
        echo [INFO] .env not found. Creating .env from .env.example...
        copy .env.example .env >nul
        echo [OK] Created .env file.
    ) else (
        echo [ERROR] .env was not found and .env.example is missing.
        goto :fail
    )
) else (
    echo [OK] .env configuration file found.
)

rem --- 3. Check Backend Dependencies ---
if not exist "node_modules" (
    echo.
    echo [INFO] Installing backend dependencies (first run only)...
    call npm.cmd install
    if errorlevel 1 (
        echo [ERROR] Backend npm install failed.
        goto :fail
    )
) else (
    echo [OK] Backend dependencies installed.
)

rem --- 4. Check Prisma Client ---
if not exist "node_modules\.prisma\client" (
    echo.
    echo [INFO] Generating Prisma database client...
    call npm.cmd run db:generate
    if errorlevel 1 (
        echo [ERROR] Prisma client generation failed.
        goto :fail
    )
) else (
    echo [OK] Prisma client ready.
)

rem --- 5. Check Frontend Dependencies ---
if not exist "frontend\node_modules" (
    echo.
    echo [INFO] Installing frontend dependencies (first run only)...
    pushd frontend
    call npm.cmd install
    if errorlevel 1 (
        popd
        echo [ERROR] Frontend npm install failed.
        goto :fail
    )
    popd
) else (
    echo [OK] Frontend dependencies installed.
)

echo.
echo --------------------------------------------------
echo   Launching Services
echo --------------------------------------------------

rem --- 6. Launch Backend Server (Port 3000) ---
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [INFO] Port 3000 is already in use. Backend server is already running.
) else (
    echo [INFO] Starting Backend Server on http://localhost:3000 ...
    start "Shopify OMS - Backend (Port 3000)" cmd /k "cd /d \"%~dp0\" && npm run dev"
)

rem --- 7. Launch Frontend Admin Panel (Port 5173) ---
netstat -ano | findstr ":5173" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [INFO] Port 5173 is already in use. Frontend admin panel is already running.
) else (
    echo [INFO] Starting Frontend Admin Panel on http://localhost:5173 ...
    start "Shopify OMS - Frontend (Port 5173)" cmd /k "cd /d \"%~dp0frontend\" && npm run dev"
)

rem --- 8. Wait 3 seconds then open Browser ---
echo.
echo Waiting for services to initialize...
timeout /t 3 /nobreak >nul

echo [INFO] Opening Admin Panel in default browser...
start http://localhost:5173

echo.
echo ==================================================
echo   Shopify OMS is now running!
echo ==================================================
echo.
echo   - Backend API:    http://localhost:3000
echo   - API Health:     http://localhost:3000/api/health
echo   - Admin Panel:    http://localhost:5173
echo.
echo Both services are running in their respective windows.
echo To stop the backend or frontend, close their window or press Ctrl+C inside it.
echo.
goto :end

:fail
echo.
echo [ERROR] Startup failed. Please check the messages above.
echo.
pause

:end
endlocal

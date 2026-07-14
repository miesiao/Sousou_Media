@echo off
cd /d "%~dp0"

if not exist ".env" (
    echo [ERROR] .env file not found.
    echo Please rename .env.example to .env and fill in your API keys.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [SETUP] Installing npm packages...
    npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Make sure Node.js v20+ is installed.
        pause
        exit /b 1
    )
)

echo.
echo [START] Sousou Publisher is starting...
echo         Open browser at http://localhost:3000
echo         Press Ctrl+C to stop
echo.

start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

node src/server.js
pause

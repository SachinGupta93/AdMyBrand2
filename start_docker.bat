@echo off
echo 🐳 Starting WebRTC VLM Object Detection with Docker
echo ================================================

REM Check if Docker Desktop is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Docker Desktop is not running!
    echo 🚀 Please start Docker Desktop and wait for it to fully load, then try again.
    echo.
    echo To start Docker Desktop:
    echo 1. Press Win key and search for "Docker Desktop"
    echo 2. Click on Docker Desktop to launch it
    echo 3. Wait for the Docker icon to appear in system tray
    echo 4. Run this script again
    pause
    exit /b 1
)

echo ✅ Docker Desktop is running
echo.
echo 🔨 Building and starting services...
docker compose up --build -d

if %errorlevel% neq 0 (
    echo ❌ Failed to start services
    pause
    exit /b 1
)

echo.
echo ⏳ Waiting for services to start...
timeout /t 5 /nobreak >nul

echo.
echo 🎉 Services started successfully!
echo 📱 Local Access: http://localhost:3000
echo 🔐 Mobile Access: https://localhost:3443
echo    (Accept the security warning for self-signed certificate)
echo.
echo 📋 Next Steps:
echo    1. Open http://localhost:3000 in your browser
echo    2. Click "Start Camera" to test locally
echo    3. For mobile: visit https://localhost:3443 and accept certificate
echo.
echo 📊 Commands:
echo    docker compose logs -f     # View logs
echo    docker compose down        # Stop services
echo.
echo 🔧 For troubleshooting, check README.md

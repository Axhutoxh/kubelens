@echo off
setlocal
echo ===================================================
echo [1/4] Compiling Freelens Rust Backend (Release)...
echo ===================================================
cd /d "%~dp0"
cargo build --release
if errorlevel 1 (
    echo [ERROR] Cargo release build failed!
    exit /b 1
)

echo.
echo [2/4] Updating freelens-rust.exe binary...
copy /y "%~dp0target\release\freelens-rust.exe" "%~dp0freelens-rust.exe"
if not exist "%~dp0frontend\bin" mkdir "%~dp0frontend\bin"
copy /y "%~dp0target\release\freelens-rust.exe" "%~dp0frontend\bin\freelens-rust.exe"

echo.
echo ===================================================
echo [3/4] Compiling Frontend Bundle...
echo ===================================================
cd /d "%~dp0frontend"
call bun run build
if errorlevel 1 (
    echo [ERROR] Frontend build failed!
    exit /b 1
)

echo.
echo Syncing frontend dist to backend dist...
xcopy /e /i /y "%~dp0frontend\dist" "%~dp0dist"

if "%1"=="--installer" goto build_installer
if "%1"=="-i" goto build_installer
if "%1"=="--dist" goto build_installer

echo.
echo ===================================================
echo SUCCESS: lensbyacp Application Build Complete!
echo Developed by Ashutosh Chandra
echo Run start-electron.bat or 'bun run electron' to launch.
echo Run 'build.bat --installer' or build-setup.bat to build the setup installer.
echo ===================================================
exit /b 0

:build_installer
echo.
echo ===================================================
echo [4/4] Packaging Setup Installer Executables...
echo ===================================================
cd /d "%~dp0frontend"
call bun run dist
if errorlevel 1 (
    echo [ERROR] Installer packaging failed!
    exit /b 1
)
echo.
echo ===================================================
echo SUCCESS: Setup Installer Executables Created!
echo Output: %~dp0frontend\release\lensbyacp Setup 1.0.1.exe
echo ===================================================
exit /b 0

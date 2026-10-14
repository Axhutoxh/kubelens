@echo off
setlocal
rem Repo root = parent of this scripts\ folder
set "ROOT=%~dp0.."
set "OUT=%ROOT%\release"

echo ===================================================
echo [1/2] Compiling React 19 Frontend Dashboard...
echo ===================================================
cd /d "%ROOT%\frontend"
call bun run build
if errorlevel 1 (
    echo [ERROR] Frontend build failed!
    exit /b 1
)

echo.
echo ===================================================
echo [2/2] Packaging Native Tauri Release and Setup Installer...
echo ===================================================
cd /d "%ROOT%"
call bun x @tauri-apps/cli build --bundles nsis
if errorlevel 1 (
    echo [ERROR] Tauri build failed!
    exit /b 1
)

echo.
echo Copying binaries and setup installer to release\ ...
if not exist "%OUT%" mkdir "%OUT%"
copy /y "%ROOT%\target\release\freelens-rust.exe" "%OUT%\kubellens.exe"
copy /y "%ROOT%\WebView2Loader.dll" "%OUT%\WebView2Loader.dll"
for %%F in ("%ROOT%\target\release\bundle\nsis\*-setup.exe") do copy /y "%%F" "%OUT%\kubellens-setup.exe"

echo.
echo ===================================================
echo SUCCESS: KUBELLENS Desktop App and Setup Installer Created!
echo ---------------------------------------------------
echo Setup installer : %OUT%\kubellens-setup.exe
echo Portable exe    : %OUT%\kubellens.exe
echo Developed by Ashutosh Chandra
echo ===================================================
exit /b 0

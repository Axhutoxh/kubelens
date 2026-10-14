@echo off
set "ROOT=%~dp0.."
cd /d "%ROOT%"
echo Launching Kubellens Desktop (Tauri v2 + Tokio + Axum)...
if exist "%ROOT%\release\kubellens.exe" (
    start "" "%ROOT%\release\kubellens.exe"
) else if exist "%ROOT%\target\release\freelens-rust.exe" (
    start "" "%ROOT%\target\release\freelens-rust.exe"
) else (
    echo Building Kubellens native desktop executable...
    call "%~dp0build.bat"
    start "" "%ROOT%\release\kubellens.exe"
)
exit /b 0

@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13+ or 24+ is required. Ask the technical owner to provide the approved runtime.
  exit /b 2
)
node "%~dp0..\..\bin\wl-quality-setup.js" %*
exit /b %errorlevel%

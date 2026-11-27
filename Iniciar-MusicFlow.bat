@echo off
chcp 65001 >nul
title MusicFlow Downloader — Servidor Local
cd /d "%~dp0"

echo ===============================================================
echo   Iniciando MusicFlow Downloader (Local + Rede Wi-Fi)...
echo ===============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale o Node.js 20+ para executar.
  pause
  exit /b 1
)

echo [1/2] Liberando portas 3000, 4000 e 8888 caso haja instancias antigas...
powershell -NoProfile -Command "foreach ($p in 3000,4000,8888) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }" >nul 2>nul

echo [2/2] Carregando servidores e abrindo http://localhost:3000 ...
echo.
node scripts/start-local.mjs

if errorlevel 1 (
  echo.
  echo [ERRO] O servidor foi encerrado com erro.
  pause
)

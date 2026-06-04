@echo off
title CONAF - Sistema de Tramites
echo.
echo  ========================================
echo    CONAF - Sistema de Seguimiento
echo    de Tramites (SIMPLE API)
echo  ========================================
echo.
echo  Iniciando servidor...
echo  Abriendo navegador en http://localhost:5001
echo.
start "" http://localhost:5001
python app.py
pause

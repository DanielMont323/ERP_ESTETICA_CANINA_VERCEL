@echo off
rem Respaldo diario de produccion. Lo ejecuta el Programador de tareas de Windows ("ERP respaldo diario").
cd /d "%~dp0.."
node scripts\respaldo-diario.js

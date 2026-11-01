@echo off
chcp 65001 > nul
title داشبورد بازاریابی - محیط لوکال هاست
cd /d "%~dp0"

echo =======================================================
echo  🚀 اجرای محیط توسعه محلی (Localhost) داشبورد بازاریابی
echo =======================================================

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo ❌ خطا: Node.js روی سیستم شما پیدا نشد.
  echo لطفاً ابتدا Node.js نسخه 22 را از سایت https://nodejs.org دانلود و نصب کنید.
  pause
  exit /b 1
)

echo 📦 ۱. بارگذاری دیتای تستی هر دو دفتر (دنیاگردی و نوآوران)...
call npm run db:restore:all

echo 🌐 ۲. باز کردن مرورگر و اجرای سرور لوکال هاست...
timeout /t 3 /nobreak > nul
start http://localhost:3000

call npm run dev
pause

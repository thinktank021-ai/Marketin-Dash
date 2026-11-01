#!/bin/bash
# 🚀 1-Click Localhost Dashboard Launcher for macOS
cd "$(dirname "$0")"

echo "======================================================="
echo " 🚀 اجرای محیط توسعه محلی (Localhost) داشبورد بازاریابی"
echo "======================================================="

# Verify Node.js
if ! command -v node &> /dev/null; then
  echo "❌ خطا: Node.js روی سیستم شما پیدا نشد."
  echo "لطفاً ابتدا Node.js نسخه 22 را از سایت https://nodejs.org دانلود و نصب کنید."
  read -p "برای خروج کلید اینتر را بزنید..."
  exit 1
fi

echo "📦 ۱. بارگذاری دیتای تستی هر دو دفتر (دنیاگردی و نوآوران)..."
npm run db:restore:all 2>/dev/null || true

echo "🌐 ۲. باز کردن مرورگر و اجرای سرور لوکال هاست..."
(sleep 3 && open "http://localhost:3000") &

npm run dev

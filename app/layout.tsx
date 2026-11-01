import type { Metadata, Viewport } from "next";
import "@fontsource-variable/vazirmatn";
import "./globals.css";
import "./enhancements.css";
import { PwaRegister } from "./pwa-register";

// Defines the browser metadata shared by every dashboard view.
export const metadata: Metadata = {
  title: "داشبورد مارکتینگ دفتر دنیاگردی",
  description: "داشبورد لحظه‌ای ورودی‌های بازاریابی دفتر دنیاگردی",
  other: {
    "codex-preview": "development",
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/** Applies Persian RTL direction and the Vazirmatn typeface at the document root. */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl">
      <body>
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}

import { APP_VERSION_LABEL } from "./app-version";

type AppCopyrightProps = { compact?: boolean };

/** Shared, small product attribution shown consistently on authentication and dashboard surfaces. */
export function AppCopyright({ compact = false }: AppCopyrightProps) {
  return (
    <footer className={`appCopyright${compact ? " compact" : ""}`} dir="rtl">
      <p>© داشبورد مارکتینگ دنیاگردی؛ برای تصمیم‌های دقیق‌تر بر پایه داده طراحی شده است.</p>
      <p>طراحی و توسعه: محمد زیارتی · نسخهٔ آزمایشی <b dir="ltr">{APP_VERSION_LABEL}</b></p>
      <a href="https://t.me/MohammADZI_0" target="_blank" rel="noreferrer">ارتباط و پشتیبانی در تلگرام</a>
    </footer>
  );
}

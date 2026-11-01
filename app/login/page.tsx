"use client";

import { useState, type FormEvent } from "react";
import "./login.css";
import "./liquid-glass.css";
import { AppCopyright } from "../app-copyright";

export default function LoginPage() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [recovery, setRecovery] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
      const data = await response.json();
      if (response.ok && data.authenticated) { window.location.replace("/"); return; }
      setMessage(data.error || "ورود انجام نشد؛ دوباره تلاش کنید.");
    } catch { setMessage("ارتباط برقرار نشد؛ اتصال اینترنت را بررسی کنید."); }
    setBusy(false);
  }
  return <main className="loginScene" dir="rtl">
    <div className="loginEdgeFrame" aria-hidden="true" />
    <div className="loginAmbient" aria-hidden="true"><i /><i /><i /></div>
    <div className="loginBrand"><b>M</b><span>داشبورد مارکتینگ<small>MARKETING MANAGER</small></span></div>
    <section className="liquidLogin" aria-labelledby="login-title">
      <div className="loginRimTrack" aria-hidden="true" />
      <div className="loginGlassReflection" aria-hidden="true" />
      <header className="loginHeading">
        <div className="loginSymbol" aria-hidden="true"><svg viewBox="0 0 100 90"><defs><linearGradient id="login-chart-fill" x2="0" y2="1"><stop stopColor="#13d7d1"/><stop offset="1" stopColor="#008b9b"/></linearGradient></defs><g fill="url(#login-chart-fill)" stroke="#28e4d8"><rect x="9" y="65" width="13" height="17" rx="3"/><rect x="32" y="50" width="13" height="32" rx="3"/><rect x="55" y="55" width="13" height="27" rx="3"/><rect x="78" y="34" width="13" height="48" rx="3"/></g><path d="m15 50 24-23 23 7 23-26" fill="none" stroke="#f7c858" strokeWidth="3"/><g fill="#183137" stroke="#f7c858" strokeWidth="3"><circle cx="15" cy="50" r="4"/><circle cx="39" cy="27" r="4"/><circle cx="62" cy="34" r="4"/><circle cx="85" cy="8" r="4"/></g></svg></div>
        <h1 id="login-title">ورود به داشبورد</h1>
        <aside className="loginAccessWarning" aria-labelledby="login-warning-title">
          <h2 id="login-warning-title"><span className="loginWarningPulse" aria-hidden="true">⛔</span>هشدار دسترسی غیرمجاز</h2>
          <p>این داشبورد محرمانه و صرفاً ویژهٔ مدیر کسب‌وکار، مدیر بازاریابی و مدیر مالیِ دارای مجوز دسترسی است. دسترسی به این صفحه، به‌معنای مجاز بودن ورود نیست. اگر مجوز ندارید، از ورود یا تلاش برای دسترسی به اطلاعات خودداری کرده و همین حالا پنجره را ببندید. دسترسی غیرمجاز قطعا پیامدهای قانونی در پی دارد.</p>
        </aside>
        <div className="loginGoldDivider" aria-hidden="true" />
      </header>
      <form className="loginForm" onSubmit={submit} aria-busy={busy}>
        <label htmlFor="login-username">نام کاربری</label>
        <div className="loginUsername"><input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} dir="ltr" required maxLength={100} disabled={busy} placeholder="نام کاربری خود را وارد کنید" /><svg className="loginFieldIcon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg></div>
        <label htmlFor="login-password">رمز عبور</label>
        <div className="loginPassword"><input id="login-password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" dir="ltr" required maxLength={256} disabled={busy} placeholder="رمز عبور خود را وارد کنید" /><svg className="loginFieldIcon" aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="12" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v3"/></svg><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "پنهان کردن رمز" : "نمایش رمز"} aria-pressed={visible}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>{visible && <path d="m3 3 18 18"/>}</svg></button></div>
        <div className="loginMessage" role="alert">{message}</div>
        <button className="loginSubmit" type="submit" disabled={busy}>{busy ? "در حال بررسی…" : "ورود"}</button>
      </form>
      <button type="button" className="loginRecovery" onClick={() => setRecovery(!recovery)} aria-expanded={recovery} aria-controls="login-recovery">رمز عبور را فراموش کرده‌اید؟</button>
      {recovery && <p id="login-recovery" className="loginRecoveryInfo">بازیابی ایمیلی در نسخهٔ آزمایشی هنوز فعال نیست. برای تغییر رمز با مسئول راه‌اندازی سامانه هماهنگ کنید. ایمیل بازیابی ارسال نشده است.</p>}
      <AppCopyright compact />
    </section>
    <p className="loginBottom">اطلاعات ورود را فقط در اختیار افراد مجاز قرار دهید.</p>
  </main>;
}

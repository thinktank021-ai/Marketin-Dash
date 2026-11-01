"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };
type SectionProps = { children: ReactNode; fallback: ReactNode };

/** Prevents a client render exception from turning the entire authenticated dashboard into a blank page. */
export class DashboardRuntimeBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[dashboard-runtime-error]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="dashboardRuntimeError" dir="rtl" role="alert">
      <section>
        <span aria-hidden="true">!</span>
        <h1>داشبورد در نمایش گزارش خطا پیدا کرد</h1>
        <p>اطلاعات حذف نشده است. صفحه را دوباره بارگذاری کنید؛ اگر خطا تکرار شد، متن خطا را برای بررسی فنی نگه دارید.</p>
        <details className="dashboardRuntimeDetails">
          <summary>جزئیات فنی خطا</summary>
          <code>{this.state.error.name}: {this.state.error.message || "پیام خطا در دسترس نیست"}</code>
        </details>
        <button type="button" onClick={() => window.location.reload()}>بارگذاری دوباره داشبورد</button>
      </section>
    </main>;
  }
}

/** Keeps one optional report section from taking down the authenticated dashboard. */
export class DashboardSectionBoundary extends Component<SectionProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[dashboard-section-runtime-error]", error, info.componentStack);
  }

  render() {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}

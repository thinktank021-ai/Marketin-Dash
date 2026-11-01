"use client";
import { useEffect, useState } from "react";

export function clearDashboardCache() {
  try { Object.keys(localStorage).filter(key => key.startsWith("marketing-dashboard:v2:last-valid:")).forEach(key => localStorage.removeItem(key)); } catch { /* Storage may be disabled. */ }
}
function returnToLogin() { clearDashboardCache(); window.location.replace("/login"); }

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let checking = false;
    let activityTimer: ReturnType<typeof setTimeout>;
    let renewing: Promise<void> | null = null;
    let lastRenewed = -Infinity;
    let expiry = Infinity;
    function scheduleExpiry(data: { expiresAt: number; serverNow: number }) {
      clearTimeout(timer);
      const remaining = Math.max(100, data.expiresAt - data.serverNow + 100);
      expiry = performance.now() + remaining;
      timer = setTimeout(checkSession, remaining);
    }
    function renewSession() {
      if (disposed || renewing) return;
      lastRenewed = performance.now();
      renewing = (async () => {
        try {
          const response = await fetch("/api/auth/activity", { method: "POST", cache: "no-store", credentials: "same-origin" });
          if (disposed) return;
          if (response.status === 401) { returnToLogin(); return; }
          if (response.ok) scheduleExpiry(await response.json());
        } catch { /* A failed activity request is not proof of expiry. */ }
        finally { renewing = null; }
      })();
    }
    const onActivity = (event: Event) => {
      if (!event.isTrusted || document.visibilityState !== "visible") return;
      clearTimeout(activityTimer);
      // Leading + trailing renewal: continuous interaction is bounded to one
      // request per 30s; the last interaction also extends the idle deadline.
      if (performance.now() - lastRenewed >= 30000 || expiry - performance.now() < 60000) renewSession();
      activityTimer = setTimeout(renewSession, 1000);
    };
    async function checkSession() {
      if (checking || disposed) return;
      checking = true;
      try {
        if (renewing) await renewing;
        const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
        if (disposed) return;
        if (response.status === 401) { returnToLogin(); return; }
        if (!response.ok) throw new Error("Temporarily unavailable");
        const data = await response.json();
        // Use server time, not the device clock; only a confirmed expiry logs out.
        scheduleExpiry(data);
      } catch { if (!disposed) timer = setTimeout(checkSession, 10000); }
      finally { checking = false; }
    }
    const onStorage = (event: StorageEvent) => { if (event.key === "dashboard:logout") returnToLogin(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void checkSession(); };
    void checkSession();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", checkSession);
    window.addEventListener("pageshow", checkSession);
    document.addEventListener("visibilitychange", onVisibility);
    const activityEvents = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"];
    activityEvents.forEach(name => document.addEventListener(name, onActivity, { passive: true }));
    return () => { disposed = true; clearTimeout(timer); clearTimeout(activityTimer); activityEvents.forEach(name => document.removeEventListener(name, onActivity)); window.removeEventListener("storage", onStorage); window.removeEventListener("focus", checkSession); window.removeEventListener("pageshow", checkSession); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  async function logout() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error("Logout failed");
      try { localStorage.setItem("dashboard:logout", String(Date.now())); } catch { /* Server session is already revoked. */ }
      returnToLogin();
    } catch { setError("خروج انجام نشد؛ دوباره تلاش کنید."); setBusy(false); }
  }
  return <div className="dashboardLogout"><button type="button" onClick={logout} disabled={busy} title="خروج از حساب کاربری"><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M10 5H5v14h5M10 12h11m-4-4 4 4-4 4" /></svg>{busy ? "در حال خروج…" : "خروج"}</button>{error && <small role="alert">{error}</small>}</div>;
}

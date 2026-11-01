"use client";

import { useEffect, useState } from "react";

export function PwaRegister() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const updateOnlineState = () => setOffline(!navigator.onLine);
    updateOnlineState();
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" });
    }
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  return offline ? (
    <div className="pwaOfflineBanner" role="status" aria-live="polite">
      حالت آفلاین فعال است · آخرین دادهٔ ذخیره‌شده نمایش داده می‌شود
    </div>
  ) : null;
}

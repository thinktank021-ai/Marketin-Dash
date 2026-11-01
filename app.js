// Entry point for cPanel Phusion Passenger (when startup file is set to app.js)
import("./server.js").catch((err) => {
  console.error("[Passenger] Failed to launch server.js:", err);
  process.exit(1);
});

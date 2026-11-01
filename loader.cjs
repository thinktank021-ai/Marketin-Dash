// CommonJS Loader for Phusion Passenger in cPanel / CloudLinux
(async () => {
  try {
    await import("./server.js");
  } catch (err) {
    console.error("[Passenger Loader] Error starting server:", err);
    process.exit(1);
  }
})();

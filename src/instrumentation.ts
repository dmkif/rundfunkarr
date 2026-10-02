export async function register() {
  // Only run on server
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initSettingsFromEnv } = await import("@/lib/env-settings");
    const initialized = await initSettingsFromEnv();
    if (initialized > 0) {
      console.log(`Initialized ${initialized} empty settings from environment variables`);
    }
    const { initCacheTTL } = await import("@/lib/cache");
    await initCacheTTL();
    console.log("Cache TTL initialized from database");
    // A failed recovery must not keep the server from starting.
    const { resumeInterruptedDownloads } = await import("@/server/download-manager");
    await resumeInterruptedDownloads().catch((error) =>
      console.error("Failed to resume interrupted downloads:", error)
    );
  }
}

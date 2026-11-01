import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

function resolveD1Binding() {
  const serverEnv = (globalThis as unknown as { __CLOUDFLARE_ENV?: { DB?: D1Database } }).__CLOUDFLARE_ENV;
  return env?.DB || serverEnv?.DB;
}

/** Returns the typed Drizzle client for future relational dashboard queries. */
export function getDb() {
  const d1 = resolveD1Binding();
  if (!d1) {
    throw new Error(
      "Database binding `DB` is unavailable. On Cloudflare, ensure D1 is bound. On Node.js/cPanel, ensure server.js has initialized the local SQLite database."
    );
  }

  return drizzle(d1, { schema });
}

/** Returns the raw D1 binding for prepared statements and atomic batches. */
export function getD1() {
  const d1 = resolveD1Binding();
  if (!d1) {
    throw new Error("Database binding `DB` is unavailable.");
  }
  return d1;
}


import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Wraps node:sqlite (native in Node.js 22+) into a Cloudflare D1-compatible interface.
 * Supports Drizzle ORM and direct statement preparation, bindings, and batching.
 */
class D1StatementWrapper {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1StatementWrapper(this.db, this.sql, values);
  }

  async first(colName) {
    try {
      const stmt = this.db.prepare(this.sql);
      const row = stmt.get(...this.values);
      if (!row) return null;
      if (typeof colName === "string") {
        return row[colName] !== undefined ? row[colName] : null;
      }
      return row;
    } catch (err) {
      console.error("[D1-SQLite] Error in first():", err.message, "SQL:", this.sql);
      throw err;
    }
  }

  async all() {
    try {
      const stmt = this.db.prepare(this.sql);
      const rows = stmt.all(...this.values);
      return {
        results: rows,
        success: true,
        meta: {}
      };
    } catch (err) {
      console.error("[D1-SQLite] Error in all():", err.message, "SQL:", this.sql);
      throw err;
    }
  }

  async run() {
    try {
      const stmt = this.db.prepare(this.sql);
      const res = stmt.run(...this.values);
      return {
        success: true,
        meta: {
          changes: res.changes,
          last_row_id: Number(res.lastInsertRowid || 0)
        }
      };
    } catch (err) {
      console.error("[D1-SQLite] Error in run():", err.message, "SQL:", this.sql);
      throw err;
    }
  }

  async raw() {
    try {
      const stmt = this.db.prepare(this.sql);
      const rows = stmt.all(...this.values);
      return rows.map(r => Object.values(r));
    } catch (err) {
      console.error("[D1-SQLite] Error in raw():", err.message, "SQL:", this.sql);
      throw err;
    }
  }
}

export class SQLiteD1Database {
  constructor(sqliteInstance) {
    this.sqlite = sqliteInstance;
  }

  prepare(sql) {
    return new D1StatementWrapper(this.sqlite, sql);
  }

  async batch(statements) {
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.all());
    }
    return results;
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }
}

/**
 * Creates a local D1-compatible database backed by a SQLite file on disk.
 */
export function createLocalD1Database(dbFilePath) {
  const fullPath = path.resolve(dbFilePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new DatabaseSync(fullPath);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  return new SQLiteD1Database(sqlite);
}

/**
 * Local Disk Bucket simulating Cloudflare R2 bucket for brand logos and uploads.
 */
export class LocalDiskBucket {
  constructor(baseDirectory) {
    this.baseDir = path.resolve(baseDirectory);
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  async get(key) {
    const filePath = path.join(this.baseDir, key);
    if (!fs.existsSync(filePath)) return null;
    const body = fs.readFileSync(filePath);
    const ext = path.extname(key).toLowerCase();
    const contentType = ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".svg" ? "image/svg+xml" : "image/png";
    return {
      body,
      httpMetadata: { contentType }
    };
  }

  async put(key, arrayBuffer, options = {}) {
    const filePath = path.join(this.baseDir, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    return { key };
  }

  async delete(key) {
    const filePath = path.join(this.baseDir, key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

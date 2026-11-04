import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
export function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    fs.readFileSync(
      new URL("../../migrations/0001_status.sql", import.meta.url),
      "utf8",
    ),
  );
  const db = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) };
        },
        async run() {
          return {
            meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const s of statements) result.push(await s.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      sqlite.close();
    },
  };
  return db;
}

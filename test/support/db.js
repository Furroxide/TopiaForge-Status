import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
export function database() {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const name of fs.readdirSync(migrations).sort())
    sqlite.exec(fs.readFileSync(new URL(name, migrations), "utf8"));
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
          const statement = sqlite.prepare(sql);
          if (statement.columns().length)
            return { results: statement.all(...args), meta: { changes: 0 } };
          return {
            meta: { changes: Number(statement.run(...args).changes) },
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

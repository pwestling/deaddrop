import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { getAuth } from "../src/lib/auth";
import { pool } from "../src/lib/db";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const migrations = await getMigrations(getAuth().options);
  await migrations.runMigrations();
  await pool.query(
    await readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8"),
  );
  console.log("Authentication and Deaddrop database schemas are ready.");
}
main()
  .finally(() => pool.end())
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

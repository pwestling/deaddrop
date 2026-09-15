import { createAuth } from "../src/lib/auth";
import { pool } from "../src/lib/db";
import { ownerEmail } from "../src/lib/config";

async function main() {
  const email = ownerEmail();
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password || password.length < 12)
    throw new Error(
      "Set OWNER_EMAIL and OWNER_PASSWORD (at least 12 characters).",
    );
  const existing = await pool.query('SELECT id FROM "user" LIMIT 1');
  if (existing.rows.length)
    throw new Error(
      "An owner already exists. Use the authenticated password-change flow.",
    );
  await createAuth(true).api.signUpEmail({
    body: {
      email,
      password,
      name: process.env.OWNER_NAME?.trim() || "Owner",
    },
  });
  console.log(
    "Owner account created. Remove OWNER_PASSWORD from the environment.",
  );
}
main()
  .finally(() => pool.end())
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

import { existsSync } from "node:fs";

/**
 * Tests run against TEST_DATABASE_URL — never the development database.
 * Loading happens before any module imports the Prisma client.
 */
export function loadTestEnv(): string {
  if (existsSync(".env")) process.loadEnvFile(".env");

  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Copy .env.example to .env, or start Postgres with `docker compose up -d db`.",
    );
  }
  process.env.DATABASE_URL = url;
  return url;
}

import { execSync } from "node:child_process";
import { loadTestEnv } from "./env";

/** Bring the test database up to the current migrations, once per run. */
export default function setup() {
  const url = loadTestEnv();
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}

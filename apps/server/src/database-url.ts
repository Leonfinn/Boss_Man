import { readFileSync } from "node:fs";

/**
 * BOSSMAN_DATABASE_PASSWORD_FILE (BOS-974): the image install keeps the database password in a file in a volume, not in .env.
 * DATABASE_URL then names no password (postgres://bossman@db:5432/bossman) and this puts the file's contents in.
 * Nothing changes when the variable is unset, or when the address already has a password.
 */
export function databaseUrl(env: NodeJS.ProcessEnv, read: (file: string) => string = (f) => readFileSync(f, "utf8")): string | undefined {
  const url = env.DATABASE_URL;
  const file = env.BOSSMAN_DATABASE_PASSWORD_FILE;
  if (!url || !file) return url;
  const u = new URL(url);
  if (u.password) return url;
  const password = read(file).trim();
  if (!password) throw new Error(`${file} is empty; run the setup step (docker compose run --rm setup).`);
  u.password = password;
  return u.toString();
}

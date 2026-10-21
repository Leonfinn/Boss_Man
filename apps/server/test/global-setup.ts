// Migrates one database for the whole run and saves it to a file, so each test file copies it
// instead of running every migration again (each file gets fresh modules, so an in-memory copy doesn't carry over).
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsFolder } from "../src/db/client.js";

export default async function setup() {
  const file = path.join(tmpdir(), `bossman-pglite-template-${process.pid}.tar`);
  const db = new PGlite({ extensions: { vector } });
  await migrate(drizzle(db), { migrationsFolder });
  writeFileSync(file, Buffer.from(await (await db.dumpDataDir("none")).arrayBuffer()));
  await db.close();
  process.env.BOSSMAN_PGLITE_TEMPLATE = file;
  return () => rmSync(file, { force: true });
}

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";

export function createPostgresDatabase(databaseUrl = process.env.LOCAL_DATABASE_URL ?? process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to create the robflow persistence database client.");
  }

  const client = postgres(databaseUrl, { max: 10 });
  const db = drizzle(client, { schema });

  return {
    db,
    close: () => client.end()
  };
}

export type RobflowDatabase = ReturnType<typeof createPostgresDatabase>["db"];

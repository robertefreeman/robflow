import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.LOCAL_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://robflow:robflow_dev_password@localhost:5432/robflow"
  }
});

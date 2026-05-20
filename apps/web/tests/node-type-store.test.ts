import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceRepositories, schema } from "@robflow/persistence";
import { createNodeType, createNodeTypeVersion, listNodeTypeLibrary, promoteBuilderNodeToNodeType } from "../lib/node-type-store";
import { createNodeData } from "../lib/workflow-builder";

const migrationsFolder = fileURLToPath(new URL("../../../packages/persistence/drizzle", import.meta.url));

describe("node type store", () => {
  let client: PGlite;
  let repos: ReturnType<typeof createPersistenceRepositories>;

  beforeEach(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    repos = createPersistenceRepositories(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it("creates visual and code-backed reusable node type versions", async () => {
    const created = await createNodeType({
      slug: "summarizer",
      displayName: "Summarizer",
      definition: { kind: "prompt-template", label: "Summarizer", category: "action", inputs: [{ id: "in" }], outputs: [{ id: "out" }], promptTemplate: "Summarize {{input}}" }
    }, repos);
    expect(created.version).toMatchObject({ version: 1 });

    const next = await createNodeTypeVersion("summarizer", {
      definition: { kind: "python-function", label: "Summarizer", category: "action", inputs: [{ id: "in" }], outputs: [{ id: "result" }], code: { kind: "python-function", module: "nodes.summary", functionName: "run" } }
    }, repos);

    expect(next.compatibility.map((issue) => issue.code)).toEqual(expect.arrayContaining(["output-removed", "code-worker-only"]));
    expect(next.palette.definition).toMatchObject({ kind: "python-function", workerOnly: true });
  });

  it("promotes workflow node data into library entries", async () => {
    const tool = createNodeData("tool");
    tool.tool = { name: "lookup" };
    tool.config = { toolName: "lookup" };

    await promoteBuilderNodeToNodeType({ slug: "lookup-tool", displayName: "Lookup Tool", node: tool }, repos);

    const entries = await listNodeTypeLibrary(repos);
    expect(entries[0]?.palette).toMatchObject({ slug: "lookup-tool", version: 1 });
  });
});

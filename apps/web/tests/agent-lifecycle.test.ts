import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceRepositories, schema } from "@robflow/persistence";
import {
  cloneAgent,
  compareVersions,
  createAgent,
  exportRobflowProject,
  exportWorkflowIr,
  getAgentDetail,
  importRobflowProject,
  rollbackVersion,
  saveBuilderGraph
} from "../lib/agents-store";
import { createInitialBuilderGraph, createNodeData, type BuilderGraph } from "../lib/workflow-builder";

const migrationsFolder = fileURLToPath(new URL("../../../packages/persistence/drizzle", import.meta.url));

describe("agent lifecycle", () => {
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

  it("keeps published versions immutable while creating draft and published history", async () => {
    const { agent } = await createAgent({ name: "Lifecycle" }, repos);
    const base = createInitialBuilderGraph(agent.id, agent.name, "1");
    const first = await saveBuilderGraph(agent.id, base, "version", repos);
    const changed: BuilderGraph = {
      ...base,
      version: "2",
      nodes: [
        base.nodes[0],
        { id: "llm", type: "robflowNode", position: { x: 280, y: 180 }, data: { ...createNodeData("llm"), model: { provider: "test", model: "demo" }, config: { model: "demo" } } },
        base.nodes[1]
      ],
      edges: [
        { id: "start-llm", source: "start", sourceHandle: "out", target: "llm", targetHandle: "in" },
        { id: "llm-end", source: "llm", sourceHandle: "out", target: "end", targetHandle: "in" }
      ]
    };
    const second = await saveBuilderGraph(agent.id, changed, "version", repos);

    const detail = await getAgentDetail(agent.id, repos);
    expect(detail.versions.map((entry) => entry.version.version)).toEqual([3, 2, 1]);
    expect(detail.currentVersion?.id).toBe(second.version.id);
    await expect(exportWorkflowIr(first.version.id, repos)).resolves.toMatchObject({ nodes: [{ id: "start" }, { id: "end" }] });
    await expect(exportWorkflowIr(second.version.id, repos)).resolves.toMatchObject({ nodes: expect.arrayContaining([expect.objectContaining({ id: "llm" })]) });
  });

  it("clones, compares, rolls back, and round trips robflow project exports", async () => {
    const { agent } = await createAgent({ name: "Exporter", description: "roundtrip" }, repos);
    const base = createInitialBuilderGraph(agent.id, agent.name, "1");
    const published = await saveBuilderGraph(agent.id, base, "version", repos);
    const draft = await rollbackVersion(agent.id, published.version.id, repos);
    const clone = await cloneAgent(agent.id, repos);
    const diff = await compareVersions(agent.id, published.version.id, draft.id, repos);

    expect(clone.agent.name).toContain("copy");
    expect(diff.graph.nodeCountDelta).toBe(0);
    expect(diff.irChanged).toBe(true);

    const project = await exportRobflowProject(agent.id, repos);
    const imported = await importRobflowProject(project, repos);
    const importedDetail = await getAgentDetail(imported.agent.id, repos);

    expect(project).toMatchObject({ format: "robflow-project", versions: expect.any(Array) });
    expect(imported.importedVersions).toBe(project.versions.length);
    expect(importedDetail.versions).toHaveLength(project.versions.length);
    await expect(importRobflowProject({ format: "not-robflow" }, repos)).rejects.toThrow("Invalid robflow project");
  });
});

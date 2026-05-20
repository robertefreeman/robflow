import { and, eq } from "drizzle-orm";
import { createPostgresDatabase } from "./db.js";
import { agentVersions, agents, nodeTypeVersions, nodeTypes } from "./schema.js";

const builtInNodeTypes = [
  {
    slug: "trigger.webhook",
    displayName: "Webhook Trigger",
    description: "Starts a workflow from an authenticated HTTP webhook payload.",
    category: "trigger",
    definition: { type: "trigger.webhook", title: "Webhook Trigger" },
    outputSchema: { type: "object", additionalProperties: true },
    runtime: { kind: "webhook" }
  },
  {
    slug: "action.adk-agent",
    displayName: "ADK Agent Step",
    description: "Delegates a node execution to the Python ADK worker.",
    category: "action",
    definition: { type: "action.adk-agent", title: "ADK Agent Step" },
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    runtime: { kind: "adk" }
  },
  {
    slug: "control.human-approval",
    displayName: "Human Approval",
    description: "Pauses a run until a human approves or rejects the request.",
    category: "control",
    definition: { type: "control.human-approval", title: "Human Approval" },
    inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    runtime: { kind: "approval" }
  }
] as const;

async function seed() {
  const { db, close } = createPostgresDatabase();

  try {
    for (const node of builtInNodeTypes) {
      const [nodeType] = await db
        .insert(nodeTypes)
        .values({
          slug: node.slug,
          displayName: node.displayName,
          description: node.description,
          category: node.category,
          builtIn: true
        })
        .onConflictDoUpdate({
          target: nodeTypes.slug,
          set: {
            displayName: node.displayName,
            description: node.description,
            category: node.category,
            builtIn: true,
            updatedAt: new Date()
          }
        })
        .returning();

      await db
        .insert(nodeTypeVersions)
        .values({
          nodeTypeId: nodeType.id,
          version: 1,
          definition: node.definition,
          inputSchema: "inputSchema" in node ? node.inputSchema : {},
          outputSchema: node.outputSchema,
          runtime: node.runtime
        })
        .onConflictDoNothing({ target: [nodeTypeVersions.nodeTypeId, nodeTypeVersions.version] });
    }

    const [agent] = await db
      .insert(agents)
      .values({
        slug: "demo-agent",
        name: "Demo Agent",
        description: "Starter agent seeded for local development.",
        metadata: { seeded: true }
      })
      .onConflictDoUpdate({
        target: agents.slug,
        set: { name: "Demo Agent", description: "Starter agent seeded for local development.", updatedAt: new Date() }
      })
      .returning();

    await db
      .insert(agentVersions)
      .values({
        agentId: agent.id,
        version: 1,
        status: "active",
        definition: {
          name: "Demo Agent",
          graph: { nodes: [], edges: [] },
          ir: { nodes: [], edges: [] }
        },
        createdBy: "seed"
      })
      .onConflictDoNothing({ target: [agentVersions.agentId, agentVersions.version] });

    const [version] = await db
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agent.id), eq(agentVersions.version, 1)))
      .limit(1);

    if (version) {
      await db.update(agents).set({ currentVersionId: version.id, updatedAt: new Date() }).where(eq(agents.id, agent.id));
    }
  } finally {
    await close();
  }
}

await seed();

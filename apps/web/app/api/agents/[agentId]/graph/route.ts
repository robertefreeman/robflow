import { NextResponse } from "next/server";
import { validateBuilderGraph, normalizeBuilderGraph } from "../../../../../lib/workflow-builder";
import { saveBuilderGraph, serializeVersion } from "../../../../../lib/agents-store";

type RouteContext = { params: Promise<{ agentId: string }> };

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext) {
  try {
    const { agentId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === "version" ? "version" : "draft";
    const graph = normalizeBuilderGraph(body.graph, agentId, "Workflow");
    const validation = validateBuilderGraph(graph);
    const saved = await saveBuilderGraph(agentId, graph, mode);
    return NextResponse.json({ version: serializeVersion(saved.version), graphId: saved.graph.id, irId: saved.ir.id, validation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save graph";
    return NextResponse.json({ error: message }, { status: message === "Agent not found" ? 404 : 500 });
  }
}

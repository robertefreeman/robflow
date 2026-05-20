import { NextResponse } from "next/server";
import { getAgentBuilderState, serializeAgent, serializeVersion, updateAgentDetails } from "../../../../lib/agents-store";

type RouteContext = { params: Promise<{ agentId: string }> };

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { agentId } = await context.params;
    const state = await getAgentBuilderState(agentId);
    return NextResponse.json({ agent: serializeAgent(state.agent), version: serializeVersion(state.version), graph: state.graph });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load agent";
    return NextResponse.json({ error: message }, { status: message === "Agent not found" ? 404 : 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { agentId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const agent = await updateAgentDetails(agentId, { name: typeof body.name === "string" ? body.name : undefined, description: typeof body.description === "string" ? body.description : null });
    return NextResponse.json({ agent: serializeAgent(agent) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update agent";
    return NextResponse.json({ error: message }, { status: message === "Agent not found" ? 404 : 500 });
  }
}

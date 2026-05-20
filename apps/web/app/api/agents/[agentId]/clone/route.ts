import { NextResponse } from "next/server";
import { cloneAgent, serializeAgent, serializeVersion } from "../../../../../lib/agents-store";

type RouteContext = { params: Promise<{ agentId: string }> };

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { agentId } = await context.params;
    const cloned = await cloneAgent(agentId);
    return NextResponse.json({ agent: serializeAgent(cloned.agent), version: serializeVersion(cloned.version) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to clone agent";
    return NextResponse.json({ error: message }, { status: message === "Agent not found" ? 404 : 500 });
  }
}

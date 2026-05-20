import { NextResponse } from "next/server";
import { getAgentDetail, serializeDetail } from "../../../../../lib/agents-store";

type RouteContext = { params: Promise<{ agentId: string }> };

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { agentId } = await context.params;
    return NextResponse.json(serializeDetail(await getAgentDetail(agentId)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load agent detail";
    return NextResponse.json({ error: message }, { status: message === "Agent not found" ? 404 : 500 });
  }
}

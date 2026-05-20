import { NextResponse } from "next/server";
import { createAgent, listAgentSummaries, serializeAgent, serializeSummary } from "../../../lib/agents-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const summaries = await listAgentSummaries(url.searchParams.get("q"));
    return NextResponse.json({ agents: summaries.map((summary) => ({ ...serializeAgent(summary.agent), summary: serializeSummary(summary) })) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to list agents" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { agent } = await createAgent({ name: typeof body.name === "string" ? body.name : "Untitled agent", description: typeof body.description === "string" ? body.description : null });
    return NextResponse.json({ agent: serializeAgent(agent) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create agent" }, { status: 500 });
  }
}

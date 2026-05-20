import { NextResponse } from "next/server";
import { getRunConsoleData } from "../../../../../lib/run-console-store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await context.params;
    return NextResponse.json(await getRunConsoleData(agentId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load run console";
    return NextResponse.json({ error: message }, { status: message === "Agent not found" ? 404 : 500 });
  }
}

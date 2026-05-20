import { NextResponse } from "next/server";
import { compileAgentVersionAdkExport } from "../../../../../lib/adk-compiler";

export async function GET(_request: Request, context: { params: Promise<{ agentVersionId: string }> }) {
  try {
    const { agentVersionId } = await context.params;
    return NextResponse.json(await compileAgentVersionAdkExport(agentVersionId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to compile ADK export" }, { status: 404 });
  }
}

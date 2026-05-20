import { NextResponse } from "next/server";
import { compileAgentVersionAdkExport } from "../../../../../lib/adk-compiler";
import { exportWorkflowIr } from "../../../../../lib/agents-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ agentVersionId: string }> }) {
  try {
    const { agentVersionId } = await context.params;
    const format = new URL(request.url).searchParams.get("format") ?? "ir";
    if (format === "adk") return NextResponse.json(await compileAgentVersionAdkExport(agentVersionId));
    if (format === "ir") return NextResponse.json(await exportWorkflowIr(agentVersionId));
    return NextResponse.json({ error: "Unsupported export format" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to export version" }, { status: 404 });
  }
}

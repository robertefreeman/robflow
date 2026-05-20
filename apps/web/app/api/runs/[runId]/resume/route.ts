import { NextResponse } from "next/server";
import { resumeRun, serializeApproval, serializeRun } from "../../../../../lib/run-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const result = await resumeRun(runId, { approvalId: typeof body.approvalId === "string" ? body.approvalId : undefined, response: body.response ?? {}, resolvedBy: typeof body.resolvedBy === "string" ? body.resolvedBy : undefined });
    return NextResponse.json({ run: serializeRun(result.run), approval: serializeApproval(result.approval) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to resume run";
    return NextResponse.json({ error: message }, { status: message.includes("not found") || message.includes("No pending") ? 404 : 400 });
  }
}

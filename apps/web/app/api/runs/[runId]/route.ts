import { NextResponse } from "next/server";
import { getRunSnapshot, serializeApproval, serializeEvent, serializeLog, serializeRun } from "../../../../lib/run-store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    const snapshot = await getRunSnapshot(runId);
    return NextResponse.json({
      run: serializeRun(snapshot.run),
      events: snapshot.events.map(serializeEvent),
      logs: snapshot.logs.map(serializeLog),
      pendingApprovals: snapshot.approvals.map(serializeApproval)
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load run" }, { status: 404 });
  }
}

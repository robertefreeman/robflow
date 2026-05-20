import { NextResponse } from "next/server";
import { cancelRun, serializeRun } from "../../../../../lib/run-store";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    return NextResponse.json({ run: serializeRun(await cancelRun(runId)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to cancel run" }, { status: 404 });
  }
}

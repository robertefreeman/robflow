import { NextResponse } from "next/server";
import { createRunForAgentVersion, serializeRun } from "../../../../../lib/run-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ agentVersionId: string }> }) {
  try {
    const { agentVersionId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const run = await createRunForAgentVersion(agentVersionId, body.input ?? {});
    return NextResponse.json({ run: serializeRun(run) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create run";
    return NextResponse.json({ error: message }, { status: message.includes("not found") ? 404 : 400 });
  }
}

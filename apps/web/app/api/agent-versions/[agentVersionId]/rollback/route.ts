import { NextResponse } from "next/server";
import { rollbackVersion, serializeVersion } from "../../../../../lib/agents-store";

type RouteContext = { params: Promise<{ agentVersionId: string }> };

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext) {
  try {
    const { agentVersionId } = await context.params;
    const body = await request.json().catch(() => ({}));
    if (typeof body.agentId !== "string") return NextResponse.json({ error: "agentId is required" }, { status: 400 });
    return NextResponse.json({ version: serializeVersion(await rollbackVersion(body.agentId, agentVersionId)) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to rollback version";
    return NextResponse.json({ error: message }, { status: message.includes("not found") ? 404 : 500 });
  }
}

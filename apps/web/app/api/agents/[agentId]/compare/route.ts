import { NextResponse } from "next/server";
import { compareVersions, serializeVersion } from "../../../../../lib/agents-store";

type RouteContext = { params: Promise<{ agentId: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext) {
  try {
    const { agentId } = await context.params;
    const url = new URL(request.url);
    const left = url.searchParams.get("left");
    const right = url.searchParams.get("right");
    if (!left || !right) return NextResponse.json({ error: "left and right version ids are required" }, { status: 400 });
    const diff = await compareVersions(agentId, left, right);
    return NextResponse.json({ ...diff, left: { ...diff.left, version: serializeVersion(diff.left.version) }, right: { ...diff.right, version: serializeVersion(diff.right.version) } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to compare versions";
    return NextResponse.json({ error: message }, { status: message.includes("not found") ? 404 : 500 });
  }
}

import { NextResponse } from "next/server";
import { promoteBuilderNodeToNodeType } from "../../../../lib/node-type-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.node !== "object" || body.node === null) {
      return NextResponse.json({ error: "node is required" }, { status: 400 });
    }
    return NextResponse.json(await promoteBuilderNodeToNodeType({ slug: typeof body.slug === "string" ? body.slug : undefined, displayName: typeof body.displayName === "string" ? body.displayName : undefined, node: body.node }), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to promote node";
    return NextResponse.json({ error: message }, { status: message.includes("already exists") ? 409 : 500 });
  }
}

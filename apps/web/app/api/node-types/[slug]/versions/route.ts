import { NextResponse } from "next/server";
import { createNodeTypeVersion } from "../../../../../lib/node-type-store";

type RouteContext = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await createNodeTypeVersion(slug, body), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create node type version";
    return NextResponse.json({ error: message }, { status: message === "Node type not found" ? 404 : 500 });
  }
}

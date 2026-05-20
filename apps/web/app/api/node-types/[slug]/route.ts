import { NextResponse } from "next/server";
import { getNodeTypeLibraryEntry, updateNodeTypeMetadata } from "../../../../lib/node-type-store";

type RouteContext = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    return NextResponse.json(await getNodeTypeLibraryEntry(slug));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load node type";
    return NextResponse.json({ error: message }, { status: message === "Node type not found" ? 404 : 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ nodeType: await updateNodeTypeMetadata(slug, body) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update node type";
    return NextResponse.json({ error: message }, { status: message === "Node type not found" ? 404 : 500 });
  }
}

import { NextResponse } from "next/server";
import { createNodeType, listNodeTypeLibrary } from "../../../lib/node-type-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ nodeTypes: await listNodeTypeLibrary() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to list node types" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await createNodeType(body), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create node type";
    return NextResponse.json({ error: message }, { status: message.includes("already exists") ? 409 : 500 });
  }
}

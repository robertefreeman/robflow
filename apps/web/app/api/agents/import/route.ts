import { NextResponse } from "next/server";
import { importRobflowProject, serializeAgent } from "../../../../lib/agents-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const imported = await importRobflowProject(body);
    return NextResponse.json({ agent: serializeAgent(imported.agent), importedVersions: imported.importedVersions }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to import project" }, { status: 400 });
  }
}

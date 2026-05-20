import { NextResponse } from "next/server";
import { getRedactedInferenceConfig, saveInferenceConfig } from "../../../../lib/inference-store";

export async function GET() {
  try {
    return NextResponse.json(await getRedactedInferenceConfig());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load inference config" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return NextResponse.json(await saveInferenceConfig(body));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save inference config" }, { status: 400 });
  }
}

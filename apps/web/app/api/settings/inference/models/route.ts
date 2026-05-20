import { NextResponse } from "next/server";
import { testInferenceConnection } from "../../../../../lib/inference-store";

export async function GET() {
  try {
    const result = await testInferenceConnection();
    if (!result.ok) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json({ models: result.models ?? [], durationMs: result.durationMs });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to discover models" }, { status: 400 });
  }
}

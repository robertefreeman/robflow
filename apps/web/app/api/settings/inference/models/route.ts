import { NextResponse } from "next/server";
import { discoverAndSaveInferenceModels } from "../../../../../lib/inference-store";

export async function GET() {
  try {
    const result = await discoverAndSaveInferenceModels();
    if (!result.ok) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json({ models: result.models ?? [], defaultModel: "defaultModel" in result ? result.defaultModel : undefined, durationMs: result.durationMs });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to discover models" }, { status: 400 });
  }
}

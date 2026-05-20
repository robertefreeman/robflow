import { NextResponse } from "next/server";
import { testInferenceConnection } from "../../../../../lib/inference-store";

export async function POST() {
  try {
    const result = await testInferenceConnection();
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Failed to test inference connection" }, { status: 400 });
  }
}

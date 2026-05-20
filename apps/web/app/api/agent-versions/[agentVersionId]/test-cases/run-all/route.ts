import { NextResponse } from "next/server";
import { runAllEvaluationTestCases, serializeEvaluationResult } from "../../../../../../lib/evaluation-store";

type RouteContext = { params: Promise<{ agentVersionId: string }> };

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { agentVersionId } = await context.params;
    const results = await runAllEvaluationTestCases(agentVersionId);
    return NextResponse.json({ results: results.map(serializeEvaluationResult) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to run test cases" }, { status: 400 });
  }
}

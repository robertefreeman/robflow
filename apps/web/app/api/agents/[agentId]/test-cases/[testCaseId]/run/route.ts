import { NextResponse } from "next/server";
import { serializeEvaluationResult, runEvaluationTestCase } from "../../../../../../../lib/evaluation-store";

type RouteContext = { params: Promise<{ agentId: string; testCaseId: string }> };

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext) {
  try {
    const { testCaseId } = await context.params;
    const body = await request.json().catch(() => ({}));
    if (typeof body.agentVersionId !== "string") throw new Error("agentVersionId is required");
    const result = await runEvaluationTestCase(body.agentVersionId, testCaseId);
    return NextResponse.json(serializeEvaluationResult(result), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to run test case" }, { status: 400 });
  }
}

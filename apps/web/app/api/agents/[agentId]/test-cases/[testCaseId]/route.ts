import { NextResponse } from "next/server";
import { deleteEvaluationTestCase, serializeTestCase, updateEvaluationTestCase } from "../../../../../../lib/evaluation-store";

type RouteContext = { params: Promise<{ agentId: string; testCaseId: string }> };

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { agentId, testCaseId } = await context.params;
    const testCase = await updateEvaluationTestCase(agentId, testCaseId, await request.json().catch(() => ({})));
    return NextResponse.json({ testCase: serializeTestCase(testCase) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update test case";
    return NextResponse.json({ error: message }, { status: message.includes("not found") ? 404 : 400 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { agentId, testCaseId } = await context.params;
    const testCase = await deleteEvaluationTestCase(agentId, testCaseId);
    return NextResponse.json({ testCase: serializeTestCase(testCase) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete test case";
    return NextResponse.json({ error: message }, { status: message.includes("not found") ? 404 : 400 });
  }
}

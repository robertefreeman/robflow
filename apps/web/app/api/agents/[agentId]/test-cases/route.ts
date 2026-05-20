import { NextResponse } from "next/server";
import { listEvaluationTestCases, saveEvaluationTestCase, serializeTestCase, serializeTestRun } from "../../../../../lib/evaluation-store";

type RouteContext = { params: Promise<{ agentId: string }> };

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { agentId } = await context.params;
    const entries = await listEvaluationTestCases(agentId);
    return NextResponse.json({ testCases: entries.map((entry) => ({ testCase: serializeTestCase(entry.testCase), runs: entry.runs.map(serializeTestRun) })) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to list test cases" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { agentId } = await context.params;
    const testCase = await saveEvaluationTestCase(agentId, await request.json().catch(() => ({})));
    return NextResponse.json({ testCase: serializeTestCase(testCase) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create test case" }, { status: 400 });
  }
}

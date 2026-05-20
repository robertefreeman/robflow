import { NextResponse } from "next/server";
import { getServerRepositories } from "../../../../../../lib/inference-store";
import { exportAdkEvaluationSet, importAdkEvaluationSet, serializeTestCase } from "../../../../../../lib/evaluation-store";

type RouteContext = { params: Promise<{ agentId: string }> };

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { agentId } = await context.params;
    const repos = getServerRepositories();
    const agent = await repos.agents.getAgent(agentId);
    if (!agent) throw new Error("Agent not found");
    const cases = await repos.evaluations.listTestCases(agentId);
    return NextResponse.json(exportAdkEvaluationSet(agent, cases));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to export ADK evaluations";
    return NextResponse.json({ error: message }, { status: message.includes("not found") ? 404 : 400 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { agentId } = await context.params;
    const repos = getServerRepositories();
    const imported = importAdkEvaluationSet(await request.json().catch(() => ({})));
    const testCases = [];
    for (const testCase of imported) testCases.push(await repos.evaluations.createTestCase({ agentId, ...testCase }));
    return NextResponse.json({ testCases: testCases.map(serializeTestCase) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to import ADK evaluations" }, { status: 400 });
  }
}

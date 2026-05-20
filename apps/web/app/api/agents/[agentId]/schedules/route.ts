import { NextResponse } from "next/server";
import { createSchedule, getRunConsoleData, serializeSchedule } from "../../../../../lib/run-console-store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await context.params;
    const data = await getRunConsoleData(agentId);
    return NextResponse.json({ schedules: data.schedules });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list schedules";
    return NextResponse.json({ error: message }, { status: message === "Agent not found" ? 404 : 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await context.params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ schedule: serializeSchedule(await createSchedule(agentId, body)) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create schedule";
    return NextResponse.json({ error: message }, { status: message.includes("not found") ? 404 : 400 });
  }
}

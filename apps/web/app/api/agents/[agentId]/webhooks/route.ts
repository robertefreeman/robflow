import { NextResponse } from "next/server";
import { createWebhook, getRunConsoleData, serializeWebhook } from "../../../../../lib/run-console-store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await context.params;
    const data = await getRunConsoleData(agentId);
    return NextResponse.json({ webhooks: data.webhooks });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list webhooks";
    return NextResponse.json({ error: message }, { status: message === "Agent not found" ? 404 : 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await context.params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ webhook: serializeWebhook(await createWebhook(agentId, body)) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create webhook";
    return NextResponse.json({ error: message }, { status: message.includes("not found") ? 404 : 400 });
  }
}

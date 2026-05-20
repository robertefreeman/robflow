import { NextResponse } from "next/server";
import { serializeRun } from "../../../../lib/run-store";
import { triggerWebhook } from "../../../../lib/run-console-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    return NextResponse.json({ run: serializeRun(await triggerWebhook(slug, request)) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to trigger webhook";
    return NextResponse.json({ error: message }, { status: message === "Invalid webhook secret" ? 401 : message.includes("not found") ? 404 : 400 });
  }
}

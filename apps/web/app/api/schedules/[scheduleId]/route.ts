import { NextResponse } from "next/server";
import { deleteSchedule, serializeSchedule, updateSchedule } from "../../../../lib/run-console-store";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ scheduleId: string }> }) {
  try {
    const { scheduleId } = await context.params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ schedule: serializeSchedule(await updateSchedule(scheduleId, body)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update schedule";
    return NextResponse.json({ error: message }, { status: message === "Schedule not found" ? 404 : 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ scheduleId: string }> }) {
  try {
    const { scheduleId } = await context.params;
    return NextResponse.json({ schedule: serializeSchedule(await deleteSchedule(scheduleId)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete schedule";
    return NextResponse.json({ error: message }, { status: message === "Schedule not found" ? 404 : 400 });
  }
}

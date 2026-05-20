CREATE TYPE "public"."runner_status" AS ENUM('starting', 'online', 'draining', 'offline');--> statement-breakpoint
CREATE TABLE "runner_registrations" (
	"runner_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"status" "runner_status" DEFAULT 'online' NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "runner_registrations_status_heartbeat_idx" ON "runner_registrations" USING btree ("status","last_heartbeat_at");
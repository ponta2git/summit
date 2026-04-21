CREATE TABLE "discord_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"session_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claim_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivered_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_outbox_kind_check" CHECK ("discord_outbox"."kind" IN ('send_message','edit_message')),
	CONSTRAINT "discord_outbox_status_check" CHECK ("discord_outbox"."status" IN ('PENDING','IN_FLIGHT','DELIVERED','FAILED'))
);
--> statement-breakpoint
ALTER TABLE "discord_outbox" ADD CONSTRAINT "discord_outbox_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_discord_outbox_dedupe_active" ON "discord_outbox" USING btree ("dedupe_key") WHERE status IN ('PENDING','IN_FLIGHT','DELIVERED');--> statement-breakpoint
CREATE INDEX "idx_discord_outbox_status_next" ON "discord_outbox" USING btree ("status","next_attempt_at");
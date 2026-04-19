CREATE TABLE "responses" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"member_id" text NOT NULL,
	"choice" text NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responses_choice_check" CHECK ("responses"."choice" IN ('T2200','T2230','T2300','T2330','ABSENT','POSTPONE_OK','POSTPONE_NG'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"week_key" text NOT NULL,
	"postpone_count" integer DEFAULT 0 NOT NULL,
	"candidate_date" date NOT NULL,
	"status" text NOT NULL,
	"channel_id" text NOT NULL,
	"ask_message_id" text,
	"postpone_message_id" text,
	"deadline_at" timestamp with time zone NOT NULL,
	"decided_start_at" timestamp with time zone,
	"cancel_reason" text,
	"reminder_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_status_check" CHECK ("sessions"."status" IN ('ASKING','POSTPONE_VOTING','POSTPONED','DECIDED','CANCELLED','COMPLETED','SKIPPED')),
	CONSTRAINT "sessions_postpone_count_check" CHECK ("sessions"."postpone_count" IN (0, 1))
);
--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "responses_session_member_unique" ON "responses" USING btree ("session_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_week_key_postpone_count_unique" ON "sessions" USING btree ("week_key","postpone_count");
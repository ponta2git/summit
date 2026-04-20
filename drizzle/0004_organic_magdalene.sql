CREATE TABLE "held_event_participants" (
	"held_event_id" text NOT NULL,
	"member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "held_event_participants_held_event_id_member_id_pk" PRIMARY KEY("held_event_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "held_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"held_date_iso" date NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "held_events_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "held_event_participants" ADD CONSTRAINT "held_event_participants_held_event_id_held_events_id_fk" FOREIGN KEY ("held_event_id") REFERENCES "public"."held_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_event_participants" ADD CONSTRAINT "held_event_participants_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_events" ADD CONSTRAINT "held_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "members" ADD COLUMN "display_name" varchar(32);
--> statement-breakpoint
UPDATE "members"
SET "display_name" = CASE
  WHEN "user_id" = (SELECT "user_id" FROM "members" WHERE "id" = 'member-1') THEN 'いーゆー'
  WHEN "user_id" = (SELECT "user_id" FROM "members" WHERE "id" = 'member-2') THEN 'おーたか'
  WHEN "user_id" = (SELECT "user_id" FROM "members" WHERE "id" = 'member-3') THEN 'あかねまみ'
  WHEN "user_id" = (SELECT "user_id" FROM "members" WHERE "id" = 'member-4') THEN 'ぽんた'
  ELSE "user_id"
END;
--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "display_name" SET NOT NULL;

CREATE TABLE "mandates_mandates" (
	"mandateId" text PRIMARY KEY NOT NULL,
	"customer" text NOT NULL,
	"agent" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"mandate" jsonb NOT NULL,
	"jws" text,
	"registeredAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mandates_mandates_owner_version" ON "mandates_mandates" USING btree ("customer","agent","version");--> statement-breakpoint
CREATE UNIQUE INDEX "mandates_mandates_one_active" ON "mandates_mandates" USING btree ("customer","agent") WHERE "mandates_mandates"."status" = 'active';
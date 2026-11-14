CREATE TABLE "orders_refusal_anchors" (
	"customer" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders_orders" ADD COLUMN "receipt" text;--> statement-breakpoint
ALTER TABLE "orders_orders" ADD COLUMN "auditAnchor" jsonb;
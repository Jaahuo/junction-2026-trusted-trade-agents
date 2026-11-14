ALTER TABLE "orders_orders" ADD COLUMN "receipt" text;--> statement-breakpoint
ALTER TABLE "orders_orders" ADD COLUMN "auditAnchor" jsonb;
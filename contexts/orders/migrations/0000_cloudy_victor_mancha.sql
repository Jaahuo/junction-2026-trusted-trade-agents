CREATE TABLE "orders_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer" text NOT NULL,
	"productId" text NOT NULL,
	"quantity" jsonb NOT NULL,
	"placedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders_orders" (
	"orderId" text PRIMARY KEY NOT NULL,
	"customer" text NOT NULL,
	"agentId" text NOT NULL,
	"accountId" text NOT NULL,
	"idempotencyKey" text NOT NULL,
	"requested" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"alternatives" jsonb NOT NULL,
	"mandateId" text,
	"mandateVersion" integer,
	"status" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"proposalVersion" integer NOT NULL,
	"paymentTerms" text NOT NULL,
	"totalNet" double precision NOT NULL,
	"totalGross" double precision NOT NULL,
	"originalRequest" text,
	"decision" jsonb,
	"requotes" jsonb NOT NULL,
	"nextDeliveryDate" text,
	"audit" jsonb NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders_refusals" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer" text NOT NULL,
	"event" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_orders_customer_idempotency_key" ON "orders_orders" USING btree ("customer","idempotencyKey");
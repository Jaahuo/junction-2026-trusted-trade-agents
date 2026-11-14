CREATE TABLE "catalog_csv_rows" (
	"source" text NOT NULL,
	"ordinal" integer NOT NULL,
	"cells" jsonb NOT NULL,
	CONSTRAINT "catalog_csv_rows_source_ordinal_pk" PRIMARY KEY("source","ordinal")
);
--> statement-breakpoint
CREATE TABLE "catalog_manifest" (
	"id" integer PRIMARY KEY NOT NULL,
	"checksums" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"sourceSchema" jsonb NOT NULL,
	"demoProducts" jsonb
);
--> statement-breakpoint
CREATE TABLE "catalog_products" (
	"ordinal" integer PRIMARY KEY NOT NULL,
	"productId" text NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "catalog_products_productId_unique" UNIQUE("productId")
);

ALTER TABLE "sales_agent" ADD COLUMN "horario" jsonb;--> statement-breakpoint
ALTER TABLE "sales_agent" ADD COLUMN "festivos" text[] DEFAULT '{}' NOT NULL;
ALTER TABLE "kb_article" ALTER COLUMN "embedding" SET DATA TYPE vector(384);--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "tipo" text;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "requiere_humano" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_agent" ADD COLUMN "tipos_lead" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_abierta_unica" ON "conversation" USING btree ("contact_id","canal") WHERE estado = 'abierta';--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_conversation_id_unique" UNIQUE("conversation_id");
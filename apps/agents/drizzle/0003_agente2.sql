CREATE TABLE "on_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"email" text NOT NULL,
	"telefono" text,
	"prioridad" integer DEFAULT 1 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "on_call_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "web_otp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destino" text NOT NULL,
	"codigo_hash" text NOT NULL,
	"expira_at" timestamp with time zone NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL,
	"usado_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "bienvenida_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "protocolo_estado" jsonb;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "proximo_paso_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "proveedor_contacto" text;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "intentos_identificacion" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "requiere_humano" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "resumen_ia" text;--> statement-breakpoint
ALTER TABLE "protocol" ADD COLUMN "moneda" text DEFAULT 'EUR' NOT NULL;--> statement-breakpoint
CREATE INDEX "web_otp_destino" ON "web_otp" USING btree ("destino");--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_abierta_por_conversacion" ON "incident" USING btree ("conversation_id") WHERE estado <> 'cerrado';--> statement-breakpoint
CREATE INDEX "incident_proveedor_contacto" ON "incident" USING btree ("proveedor_contacto");--> statement-breakpoint
CREATE INDEX "incident_proximo_paso" ON "incident" USING btree ("proximo_paso_at");
CREATE TABLE "booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"contact_id" uuid,
	"viajero_nombre" text NOT NULL,
	"viajero_telefono" text,
	"viajero_email" text,
	"destino" text NOT NULL,
	"inicio" timestamp with time zone NOT NULL,
	"fin" timestamp with time zone NOT NULL,
	"servicios" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_codigo_unique" UNIQUE("codigo")
);
--> statement-breakpoint
CREATE TABLE "business_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mercado" text NOT NULL,
	"zona_horaria" text NOT NULL,
	"horario" jsonb NOT NULL,
	"festivos" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "business_hours_mercado_unique" UNIQUE("mercado")
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text,
	"telefono" text,
	"email" text,
	"idioma" text,
	"mercado" text,
	"canal_preferido" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_telefono_unique" UNIQUE("telefono"),
	CONSTRAINT "contact_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"canal" text NOT NULL,
	"agente" text,
	"estado" text DEFAULT 'abierta' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"conversation_id" uuid,
	"tipologia" text,
	"urgencia" text,
	"estado" text DEFAULT 'identificando' NOT NULL,
	"protocol_id" uuid,
	"escalado_a" text,
	"sla_vence" timestamp with time zone,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cerrado_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "incident_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"detalle" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"monto" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"titulo" text NOT NULL,
	"contenido" text NOT NULL,
	"idioma" text DEFAULT 'es' NOT NULL,
	"etiquetas" text[] DEFAULT '{}' NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kpi_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo" text NOT NULL,
	"agente" text,
	"canal" text,
	"valor" double precision,
	"ref_id" uuid,
	"datos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"destino" text,
	"fecha_inicio" date,
	"fecha_fin" date,
	"viajeros" integer,
	"interes" text,
	"urgencia" text,
	"score" integer,
	"estado" text DEFAULT 'nuevo' NOT NULL,
	"sales_agent_id" uuid,
	"resumen_ia" text,
	"fuera_de_horario" boolean DEFAULT false NOT NULL,
	"mercado" text,
	"idioma" text,
	"entregado_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"canal" text NOT NULL,
	"direccion" text NOT NULL,
	"contenido" text NOT NULL,
	"external_id" text NOT NULL,
	"agente" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_canal_external_id" UNIQUE("canal","external_id")
);
--> statement-breakpoint
CREATE TABLE "protocol" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"nombre" text NOT NULL,
	"version" integer NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"definicion" jsonb NOT NULL,
	"tope_autorizado" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protocol_codigo_version" UNIQUE("codigo","version")
);
--> statement-breakpoint
CREATE TABLE "sales_agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"email" text NOT NULL,
	"destinos" text[] DEFAULT '{}' NOT NULL,
	"idiomas" text[] DEFAULT '{}' NOT NULL,
	"mercados" text[] DEFAULT '{}' NOT NULL,
	"zona_horaria" text,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_agent_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_protocol_id_protocol_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocol"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_action" ADD CONSTRAINT "incident_action_incident_id_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_sales_agent_id_sales_agent_id_fk" FOREIGN KEY ("sales_agent_id") REFERENCES "public"."sales_agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;
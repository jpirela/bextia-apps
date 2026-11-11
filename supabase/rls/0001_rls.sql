-- RLS de BEXTIA. Se aplica a mano, con aprobación, contra la conexión directa (5432):
--   psql "$DATABASE_URL_DIRECT" -f supabase/rls/0001_rls.sql
-- La API usa el rol dueño (no sujeto a RLS). Esto cierra el acceso directo con la clave publicable.
-- Idempotente: se puede volver a correr.
-- Sin políticas para anon (deny-all). authenticated solo lee lead, incident y su propia fila de sales_agent.
-- El rol se lee solo de app_metadata (lo fija el servidor); nunca de los metadatos editables por el usuario.

BEGIN;

ALTER TABLE public.contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_agent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protocol ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_article ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpi_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.on_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_otp ENABLE ROW LEVEL SECURITY;

-- Lecturas por rol (sin escrituras: todo cambio pasa por la API).
DROP POLICY IF EXISTS lead_select_por_rol ON public.lead;
CREATE POLICY lead_select_por_rol ON public.lead FOR SELECT TO authenticated USING (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  OR (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'comercial'
    AND sales_agent_id IN (SELECT id FROM public.sales_agent WHERE lower(email) = lower(auth.jwt() ->> 'email'))
  )
);

DROP POLICY IF EXISTS incident_select_por_rol ON public.incident;
CREATE POLICY incident_select_por_rol ON public.incident FOR SELECT TO authenticated USING (
  (auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin', 'operador')
);

-- La subconsulta de lead_select_por_rol corre con los permisos del invocador: sin esta política
-- devolvería vacío. Cada usuario autenticado ve solo la fila de sales_agent con su email.
DROP POLICY IF EXISTS sales_agent_select_propio ON public.sales_agent;
CREATE POLICY sales_agent_select_propio ON public.sales_agent FOR SELECT TO authenticated USING (
  lower(email) = lower(auth.jwt() ->> 'email')
);

COMMIT;

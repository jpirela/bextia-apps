# Bextia apps

Aplicaciones de BEXTIA agentes en un monorepo de yarn:

- `apps/agents` (`@bextia/agents`): API de los agentes. Agente 1 atiende leads fuera de horario y Agente 2 gestiona incidencias.
- `apps/backoffice` (`@bextia/backoffice`): panel de operación.

Las migraciones están en `apps/agents/drizzle`, la RLS y la Edge Function en `supabase/` y el despliegue en `render.yaml` (servicio web y static site).

El esquema de datos vive en [bextia-api](https://github.com/jpirela/bextia-api) y llega como dependencia git fijada a un tag (`@bextia/api`, importado desde `@bextia/api/schema`). Para cambiarlo, se publica un tag nuevo en bextia-api, se sube la versión en `apps/agents/package.json` y se corre `yarn install`. La documentación (entregables 01–14 y propuesta) está en [bextia-entregables](https://github.com/jpirela/bextia-entregables).

## Comandos

```
yarn install
yarn workspace @bextia/agents dev
yarn test
yarn typecheck
yarn build
```
## Backoffice

Panel Vite + Lara Fluent para comerciales, operadores y administradores. El acceso depende del rol del usuario.

### Configuración

- El login va por la API (`/api/auth`), que habla con Supabase Auth. El frontend no usa `supabase-js`.
- La única variable de entorno es `VITE_API_URL` (ver `apps/backoffice/.env.example`), la URL base de la API.
- `CORS_ORIGINS` de la API debe incluir la URL del backoffice.
- El CSP `connect-src` de `render.yaml` debe coincidir con `VITE_API_URL`; si no, el navegador bloquea el login.

### Comandos

```
yarn workspace @bextia/backoffice dev
yarn workspace @bextia/backoffice test
yarn workspace @bextia/backoffice typecheck
yarn workspace @bextia/backoffice build
```

### RLS y roles

La RLS está en `supabase/rls/0001_rls.sql`. Se aplica a mano en el SQL editor del proyecto Supabase.

Los roles viven en `app_metadata.role`. Para asignar uno:

```sql
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}' where email = 'admin@ejemplo.com';
```

La verificación de la RLS tiene un test estático del SQL (`apps/agents/src/db/rls.test.ts`); la verificación contra Supabase real es manual. Se comprueba a mano en el proyecto Supabase real, entrando con cada rol.

Aplicar la RLS, crear usuarios y asignar roles en el proyecto Supabase real requiere aprobación previa y no lo hace ningún script del repo.

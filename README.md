# Bextia agentes

Monorepo con la API de agentes (`apps/agents`, `@bextia/agents`) y el panel de operación (`apps/backoffice`, `@bextia/backoffice`). Gestor de paquetes: yarn.

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

La verificación de la RLS es manual: no hay test automatizado. Se comprueba a mano en el proyecto Supabase real, entrando con cada rol.

Aplicar la RLS, crear usuarios y asignar roles en el proyecto Supabase real requiere aprobación previa y no lo hace ningún script del repo.

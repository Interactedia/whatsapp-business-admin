# Verificación operativa de Settings

**No usar mocks.** Esta guía ejecuta la aplicación real (Next.js + PostgreSQL + Redis/BullMQ + workers) y demuestra el comportamiento de Settings mediante requests HTTP reales y consultas SQL reales.

## Prerrequisitos

- App en pie en puerto aislado. Para entorno por defecto: `./scripts/dev.sh start`. Para ERA 5 aislado (puerto 4030, DB `whatsapp_era5_test`, Redis namespace `wa-queue-era5`):
  ```bash
  set -a && . ./.env.era5 && set +a && ./scripts/era5-start.sh
  ```
- Seed cargado (corre solo con `WBA_ALLOW_DEMO_SEED=true` o `SEED_ADMIN_PASSWORD` configurado). Ver `prisma/seed.ts`.

## 1. Login real

```bash
# CSRF token + cookie jar
CSRF=$(curl -s -c /tmp/cookies.txt http://localhost:4030/api/auth/csrf | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")
curl -s -b /tmp/cookies.txt -c /tmp/cookies.txt -X POST \
  -d "email=admin@acme.com&password=123456&csrfToken=$CSRF&callbackUrl=http%3A%2F%2Flocalhost%3A4030%2F" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  http://localhost:4030/api/auth/callback/credentials -i

# Confirmar sesión
curl -s -b /tmp/cookies.txt http://localhost:4030/api/auth/session
```

## 2. Estado inicial (GET real)

```bash
curl -s -b /tmp/cookies.txt http://localhost:4030/api/tenants/acme/settings | python3 -m json.tool
```

Verificar campos: `wabaId`, `metaAppId`, `phoneNumberId`, `accessTokenSet`, `appSecretSet`, `connected`.

## 3. Escenario primario (especificación del task)

**3.1** Guardar nuevo `accessToken` con `appSecret` vacío.

```bash
curl -s -b /tmp/cookies.txt -X PUT -H "Content-Type: application/json" \
  -d '{"accessToken":"EAA_real_token_AAA","appSecret":""}' \
  http://localhost:4030/api/tenants/acme/settings
```

Resultado esperado: `accessTokenMasked: "EAA_…_AAA"`, `appSecretSet: true` (preservado).

**3.2** Guardar nuevo `appSecret` con `accessToken` vacío.

```bash
curl -s -b /tmp/cookies.txt -X PUT -H "Content-Type: application/json" \
  -d '{"accessToken":"","appSecret":"new_app_secret_BBB"}' \
  http://localhost:4030/api/tenants/acme/settings
```

Resultado esperado: `accessTokenMasked: "EAA_…_AAA"` (accessToken anterior **intacto**), `appSecretSet: true` (nuevo).

**3.3** Recargar (GET) y verificar persistencia.

```bash
curl -s -b /tmp/cookies.txt http://localhost:4030/api/tenants/acme/settings | python3 -m json.tool
```

Resultado esperado: idéntico al 3.2 (DB real persiste los cambios).

**3.4** Actualizar campo no-secreto con ambos secretos vacíos.

```bash
curl -s -b /tmp/cookies.txt -X PUT -H "Content-Type: application/json" \
  -d '{"metaAppId":"new_app_id_CCC","accessToken":"","appSecret":""}' \
  http://localhost:4030/api/tenants/acme/settings
```

Resultado esperado: `metaAppId: "new_app_id_CCC"`, ambos secretos intactos.

## 4. Verificación a nivel base de datos (PostgreSQL real)

```bash
set -a && . ./.env.era5 && set +a
PGPASSWORD=wa psql -h localhost -p 5434 -U wa -d whatsapp_era5_test \
  -c "SELECT \"metaWabaId\", \"metaAppId\", length(\"accessTokenEnc\") AS token_bytes, \"appSecret\" IS NOT NULL AS secret_set FROM \"WabaAccount\" WHERE \"tenantId\"='acme';"
```

Campos observados:
- `token_bytes` (longitud del blob cifrado) debe ser > 0 si `accessToken` está seteado.
- `secret_set` debe ser `t` mientras `appSecret` esté presente.

Esto **certifica** la persistencia independientemente de la API.

## 5. Aislamiento de tenant (regresión crítica)

```bash
# Tenant distinto, login con admin@default.com
CSRF2=$(curl -s -c /tmp/cookies2.txt http://localhost:4030/api/auth/csrf | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")
curl -s -b /tmp/cookies2.txt -c /tmp/cookies2.txt -X POST \
  -d "email=admin@default.com&password=123456&csrfToken=$CSRF2&callbackUrl=http%3A%2F%2Flocalhost%3A4030%2F" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  http://localhost:4030/api/auth/callback/credentials -i

# Tenant A admin intenta leer tenant B -> 403/redirect
curl -s -b /tmp/cookies2.txt -o /dev/null -w "%{http_code}\n" http://localhost:4030/api/tenants/acme/settings
```

Resultado esperado: 403 (cross-tenant denegado por `requireTenantAdminApi`).

## 6. Restablecer ambiente después de la verificación

```bash
# Limpiar token de demo y restaurar appSecret
psql ... -c "UPDATE \"WabaAccount\" SET \"accessTokenEnc\"=NULL, \"appSecret\"='test-app-secret-do-not-use', \"metaAppId\"='' WHERE \"tenantId\"='acme';"
```

## 7. Suite de regresiones automatizadas (sin mocks nuevos)

```bash
# Solo Vitest, sin lógica de producción añadida
npx vitest run
```

Suite: 1039 tests. No incrementa con esta tarea. Las pruebas existentes se concentran en seguridad (tenant isolation, autorización, idempotencia, integridad de firma webhook) y regresiones críticas. La validación de comportamiento end-to-end de Settings se hace con los pasos 1-4 de esta guía.

## Política

- **No** crear tests con mocks nuevos. Si necesitas verificar un cambio de comportamiento, ejecuta la app real y reproduce el escenario.
- **No** usar respuestas hardcodeadas para certificar integraciones reales. Si el test depende de una respuesta fija, no certifica nada.
- **No** añadir código de tests a `src/`. La instrumentación de runtime (p. ej. health checks) sigue siendo código de producción legítimo.
- **Sí** preservar todas las regresiones automatizadas existentes (seguridad, aislamiento, idempotencia, integridad) y los tests de lógica pura sin mocks.

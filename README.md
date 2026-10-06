# CD Residentes · Diwilo Residential AI

App web multi-tenant para administraciones de propiedad horizontal: conjuntos, propietarios y unidades, cartera,
portería, PQRS, reservas de zonas comunes, mascotas, comunicados y un **chat con IA** (Diwilo AI) que responde con
los datos en vivo de la administración.

Publicada en **https://cdresidentes.diwilo.com**.

## Arquitectura

- **Un solo Cloudflare Worker** sirve la API (`/api/*`) y el panel (`/admin/*`, HTML sueltas en `public/`).
- **Frontend:** HTML sueltas + Bootstrap 5 + Bootstrap Icons + Vanilla JS. Sin SPA, sin router, sin build.
- **Backend:** router propio mínimo ([src/router.js](src/router.js)); validaciones en el Worker.
- **Datos:** D1 (SQLite), una sola base. Toda tabla de negocio lleva `business_id`; `tenantDb()` ([src/lib/db.js](src/lib/db.js))
  rechaza SQL sin ese filtro y el valor sale siempre de la sesión. Las escrituras pasan por [src/lib/crud.js](src/lib/crud.js),
  que además comprueba que cada referencia (`property_id`, `unit_id`, `amenity_id`) sea del mismo negocio.
- **Archivos:** R2 (`cdresidentes-files`). Adjuntos: `<business_id>/<tipo>/<id>/<uuid>`; logos: `<business_id>/brand/<uuid>`.
- **Seguridad:** el login de Diwilo (correo + contraseña PBKDF2, bloqueo tras 5 fallos, sesión en D1 con cookie HttpOnly).
  Las mutaciones exigen el encabezado `x-cdr: 1` (CSRF). Sin Cloudflare Access.
- **IA:** Workers AI (binding `AI`, modelo Llama 3.3 70B) — dentro de Cloudflare, sin BaaS externo ([src/api/ai.js](src/api/ai.js)).
- **Integraciones:** WhatsApp vía Evolution API ([src/integrations/whatsapp.js](src/integrations/whatsapp.js)) y correo vía
  SMTP de Gmail con sockets TCP ([src/integrations/email.js](src/integrations/email.js)).

```
src/
  index.js            entrada: API, páginas /admin, multi-tenant por ruta /<slug>
  router.js           router con nivel de auth por ruta
  lib/                http, db (guardia de tenant), crud, auth (contraseña + sesión + suscripción), tenant, time
  api/                auth, platform (Diwilo), business (+equipo), dashboard, properties, units, charges,
                      requests, pqrs, bookings, pets, notices, files, ai, portal (propietarios)
  integrations/       whatsapp, email
public/admin/         login, index, conjuntos, unidades, cartera, solicitudes, pqrs, reservas, mascotas,
                      comunicados, asistente (chat), ajustes
public/portal/        portal de propietarios: index, comunicados, cartera, unidad, mascotas, reservas
migrations/           esquema D1
```

## Módulos

| Página | Qué hace |
|---|---|
| Inicio | KPIs (unidades, habitantes, cartera vencida, % mora, PQRS, visitas), insight de IA, atrasos más altos, portería, reservas, comunicados |
| Conjuntos | Sedes de la administración: NIT, dirección, torres, logo (R2) y documentos (actas, reglamento) |
| Propietarios | Directorio de unidades con propietario/arrendatario, área, coeficiente; filtros por torre, tipo y mora; desglose de cobros; WhatsApp y **cobro con IA** |
| Cartera | **Estado de cuenta por unidad** (cuota de administración con *Items cobro*, RTC/EXT, JUR/INT, parqueadero/otros, total adeudado y fila de totales) y **Movimientos**. Pagos por item o totales, antigüedad 0‑30/31‑60/61‑90/90+, recaudo de 12 meses. Menú **Liquidar**: cuotas del mes (coeficiente, área o fijo), intereses de mora, cobro jurídico, retroactivo y cuota extraordinaria en N cuotas. **Cuenta de cobro PDF** por unidad o de todo el conjunto |
| Portería | Mudanzas, visitas, mantenimiento, domicilios y alarmas con aprobación y evidencias |
| PQRS | Peticiones, quejas, reclamos y sugerencias por categoría y prioridad, tiempo promedio de respuesta, **respuesta con IA** |
| Reservas | Zonas comunes con tarifa por evento/hora/día, calendario mensual, choque de horarios, aprobación y pago |
| Mascotas | Censo con vacunas, razas potencialmente peligrosas, foto y carné (R2) |
| Comunicados | Circulares con plantillas y **redacción con IA**; envío a todos, solo propietarios o solo morosos por WhatsApp y correo (BCC) |
| Diwilo AI | Chat con historial por usuario. Cada respuesta se arma con un resumen en vivo (cartera y deudores, PQRS, portería, reservas, mascotas, comunicados) del negocio o del conjunto activo. Los borradores entre `---INICIO---`/`---FIN---` se pueden publicar como comunicado o enviar por WhatsApp |
| Ajustes | Datos y logo de la administración, instancia de WhatsApp, **Cartera y cuenta de cobro** (formato del PDF, día de vencimiento, % de interés y su base, % y días del cobro jurídico, % de retroactivo, reparto y cuotas de extraordinarias, nota al pie), equipo con links de invitación, pruebas de WhatsApp y correo |

El selector **Conjunto** de la barra superior filtra todas las páginas (se recuerda en el navegador).

## Portal de propietarios

`/<slug>/portal` es la parte de los propietarios y residentes. Cada persona solo ve las unidades a las que está vinculada
(tabla `residents`, nivel de auth `resident` en [src/api/portal.js](src/api/portal.js)); no es miembro del negocio y no entra al panel.

| Página | Qué hace |
|---|---|
| Inicio | Saldo pendiente y vencido, próximo vencimiento, último pago, últimos comunicados y próximas reservas |
| Comunicados | Circulares publicadas para todos los conjuntos o el suyo, con búsqueda, categoría y adjuntos |
| Mi cartera | Total a pagar, vencido y por vencer; cobros pendientes y pagos de 24 meses (descargables); pendiente por concepto; forma de pago; **cuenta de cobro PDF** (la misma del panel) |
| Mi unidad | Datos de la unidad y del conjunto, contacto de la administración, documentos del conjunto (reglamento, actas); la persona actualiza su celular, habitantes y placas |
| Mascotas | Registrar, editar y retirar mascotas con foto o carné y vacunas; la administración las ve en su censo |
| Reservas | Zonas de su conjunto con tarifa y reglamento, calendario de ocupación (sin datos de otras unidades), valor estimado; la solicitud queda **por aprobar** y se puede cancelar |

**Dar acceso:** en Propietarios → ficha de la unidad → *Acceso al portal* (propietario, arrendatario u otro correo). Si la persona
no tiene contraseña recibe un link de invitación que la lleva a crear la contraseña y entrar a su portal; se puede enviar por
WhatsApp o correo desde ahí. Con varias unidades elige cuál ver en la barra superior. Al entrar por `/` o `/admin` sin ser del
equipo, la app la lleva a su portal.

**Tablas:** todas las listas usan DataTables (búsqueda, orden, paginación, columnas adaptables en celular) con descarga en
Copiar, Excel, CSV, PDF e Imprimir; las columnas de montos llevan total en el pie y la descarga trae los valores como números
(en cartera, una columna por concepto). Las librerías se cargan solo en las páginas con tablas, y pdfmake solo al pedir un PDF.

**Cuenta de cobro (PDF):** se arma en el navegador con pdfmake ([public/admin/assets/cuenta-cobro.js](public/admin/assets/cuenta-cobro.js))
con los siete conceptos, periodos, estado (vencido / por vencer), total a pagar, forma de pago del conjunto y nota de Ajustes.
Formatos: **media carta** (una por hoja), **carta original y copia** (propietario y administración, con línea de corte) o
**carta en serie** (dos unidades por hoja, para imprimir todo el conjunto).

## Plataforma Diwilo

Los negocios (administraciones), sus propietarios y la suscripción se manejan desde **Diwilo Web** (`diwilo.com/admin`),
que llama a `/api/platform/*` con `Authorization: Bearer PLATFORM_KEY` ([src/api/platform.js](src/api/platform.js)),
con el mismo contrato que Pedidos, Nutrición y Citas.

- **Crear negocio:** Diwilo hace `POST /api/platform/businesses` y recibe el link de invitación del propietario (`/#invite=…`).
- **Entrar:** un solo link, `https://cdresidentes.diwilo.com/`. Con correo y contraseña la app lleva a `/<slug>/admin/`.
  Si el correo está en varias administraciones, pregunta a cuál entrar.
- **Olvidó la contraseña:** Diwilo (o el propietario desde Ajustes → Equipo) genera un link nuevo.
- **Suscripción:** `businesses.paid_until` (`YYYY-MM-DD`; vacío = sin límite). Si la fecha pasó, la administración queda
  en **solo lectura**: las escrituras responden 402 y el panel muestra una barra roja. Leer y entrar sigue funcionando.

## Desarrollo local

```sh
npm install
cp .dev.vars.example .dev.vars          # PLATFORM_KEY local
npm run db:migrate:local
npm run dev                             # http://localhost:8787
```

Crear un negocio de prueba:

```sh
curl -X POST localhost:8787/api/platform/businesses -H "authorization: Bearer <PLATFORM_KEY>" \
  -H 'content-type: application/json' -d '{"name":"Altos de la Colina","owner_email":"tu@correo.co","paid_until":null}'
# abre http://localhost:8787 + invite_path para crear la contraseña
```

El binding `AI` siempre usa Workers AI remoto (requiere `wrangler login`), también en local.

## Despliegue

**Git + GitHub + Workers Builds:** cada push a `main` en `diwilotech/cdresidentes` despliega. El comando de build
(`wrangler.jsonc → build`) aplica las migraciones de D1 pendientes **antes** del deploy; si una migración falla, no se despliega.

Recursos (ya creados): Worker `cdresidentes`, D1 `cdresidentes`, R2 `cdresidentes-files`, dominio `cdresidentes.diwilo.com`.

Secretos (`npx wrangler secret put <NOMBRE>`):

| Secreto | Para |
|---|---|
| `PLATFORM_KEY` | la misma clave que usa Diwilo Web con las demás apps |
| `SMTP_USER` / `SMTP_PASS` | cuenta Gmail + contraseña de aplicación |
| `EVOLUTION_URL` / `EVOLUTION_KEY` | servidor Evolution API (cada administración pone su instancia en Ajustes) |

## Conectar en Diwilo Web

En el repo `diwilo-Web`:

1. `wrangler.jsonc`: en `services` → `{ "binding": "RESIDENTES", "service": "cdresidentes" }`; en `vars` → `"RESIDENTES_URL": "https://cdresidentes.diwilo.com"`.
2. `worker/src/platform.js`, en `APPS`:
   `residentes: { name: 'Residentes', binding: 'RESIDENTES', url: 'RESIDENTES_URL', roles: ['owner', 'admin', 'staff'], slug: 'optional' }`.
3. El link de ingreso es la raíz del dominio (`loginUrl` ya lo resuelve igual que Citas).

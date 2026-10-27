# CD Residentes — guía rápida

Responde en español. Modo económico: sin capturas salvo que se pidan; de las pruebas mostrar solo el resumen.

## Qué es
App `cdresidentes` (cdresidentes.diwilo.com) para administradoras de propiedad horizontal: una administración (negocio) maneja varios conjuntos (`properties`, el **ámbito** de la app). Cloudflare Workers + D1 `cdresidentes` + R2 `cdresidentes-files`, JS sin framework, Bootstrap. Publica con Workers Builds al hacer push a `main` (aplica migraciones). Repo diwilotech/cdresidentes.

## Mapa (arquitectura común de las apps Diwilo, igual que CD Academia)
- Direcciones: `/` ingreso (`public/index.html`, con `#invite=` para crear contraseña) · `/<slug>` panel (`public/staff/panel.html`: shell + un marco `#dw-frame`) · `/staff/<modulo>.html` página de cada módulo (abierta directo lleva al panel) · `/<slug>/portal/…` portal de propietarios (`public/portal`, cédula o correo; usa `public/admin/assets/app.js`, aparte del panel) · `/<slug>/admin/*` y `/admin/*` (viejas) redirigen al panel.
- `modulos.app.json`: módulos propios (conjuntos, unidades=Propietarios, cartera, porteria (solicitudes + reservas + comunicados), pqrs, mascotas, ajustes), centrales (`finanzas`, `marketing`, `nomina`, `marca`, `ai`, `dashboard`=Inicio, de Diwilo Modulos por binding `MODULOS`) y `ambito` (Conjunto: el shell pinta su selector en la barra y el Inicio muestra el portafolio). Módulos BASE siempre activos: `dashboard`, `marca`, `ai`, `equipo`.
- Auth: `src/lib/auth.js` → `authenticate(c, 'tenant:<modulo>' | 'manager:<modulo>' | 'session' | 'public' | 'platform' | 'resident')` comprueba sesión, rol, módulo activo (`business_modules`, lo asigna Diwilo por `src/api/platform-modules.js`) y suscripción (vencida = solo lectura). CSRF: `x-app: 1` o `x-cdr: 1` en escrituras.
- Módulos propios: `src/api/<modulo>.js` con rutas `/api/admin/…` (properties, units, charges+billing, requests, pqrs, bookings, pets, notices, business=ajustes y equipo, files, ai=borradores con IA, dashboard=estadísticas del conjunto). Las páginas viven en `public/staff/<modulo>.html` y usan `public/js/residentes.js` (`App.*`: API, formatos, tablas, formularios, conjunto activo `cdr_property_<slug>`), no el `App` común (que usan las páginas centrales).
- Inicio: `public/staff/index.html` carga el Dashboard central (`/m/dashboard.js`) y `public/js/pages/inicio.js` registra el ámbito Conjunto (`DwDashboardAmbito`) y los indicadores del conjunto (`DwDashboard`). La plantilla `DW_KEEP_APP` evita que `residentes.js` pise el `App` común; `centralPage` (`src/lib/central.js`) arma las páginas centrales con ese mismo molde.
- Portería es UN módulo con tres pestañas (`public/staff/porteria.html`; `?tab=reservas|comunicados`): Solicitudes, Reservas (calendario mes/semana en `public/js/pages/porteria-reservas.js`; reservas de varios días con `bookings.end_date`; relleno = estado, franja lateral = zona/tipo) y Comunicados. Sus APIs (`requests`, `bookings`/`amenities`, `notices`) se protegen con `porteria`.
- Cartera por unidad (propia de propiedad horizontal) y Finanzas (contabilidad de la administradora) son DISTINTAS y no se mezclan.
- IA: el chat «Diwilo AI» se reemplazó por el módulo central `ai`. Sus herramientas propias: `src/ia/residentes.js` (resumen en vivo) y `src/ia/control.js` (llaman a las MISMAS rutas de la API con `herramienta()` de `src/ia/interno.js`). Borradores de cobro y circulares: `POST /api/admin/ai/draft`.
- Marca: logo, color y modo por negocio (`/api/settings/*`, `business_settings`; el logo es `businesses.logo_key`). Sin «Apariencia» en el menú de usuario.
- Contrato con Diwilo (NO tocar salvo lo del módulo): `src/api/platform.js`, `src/lib/platform-rpc.js`, `export class Platform`, roles owner/admin/staff, `paid_until`, invitación por `/#invite=`.

## Comandos
- `npm run db:migrate:local && npm test` → «Todo bien» (levanta la app + Diwilo Modulos de la carpeta hermana; wrangler ≥ 4.151).
- `node scripts/ui-check.mjs` → recorre el panel en Chrome (CHROME=…); no es parte de `npm test`.
- Si las pruebas dan 500 en `/m/*.js`: wrangler viejo en node_modules (actualizar) o procesos `workerd` sobrantes (`pkill -f workerd`).

## Reglas
- Toda consulta filtra por negocio (`tenantDb`). Vencida = solo lectura.
- Migraciones nuevas: solo agregar, preservar datos (nunca DROP de tablas con datos).
- Push/publicar solo con confirmación del usuario. Publicar Diwilo Modulos antes que esta app.

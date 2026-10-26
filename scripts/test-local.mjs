// Prueba de punta a punta en local: Diwilo (simulado) crea negocios por RPC y se recorre la app completa.
// Uso: npm run db:migrate:local && npm test   (usa Diwilo Modulos de la carpeta hermana para los módulos centrales)
import { startApp, check, failures, diwilo, client, mcp, newBusiness, newMember, APP } from './test-helpers.mjs';

await startApp();

try {
  const A = await newBusiness('Admin A', { login: true });
  const app = A.app;
  const bid = A.id, slug = A.created.data.slug;
  check('Diwilo crea una administración por RPC', A.created.status === 201 && A.created.data.invite_path);
  check('Desde internet /api/platform da 401', (await client()('/api/platform/businesses')).status === 401);
  check('Desde internet /api/platform/modules da 401', (await client()('/api/platform/modules')).status === 401);

  // --- Shell: /api/me, páginas y direcciones ---
  const me = await app('/api/me');
  check('/api/me trae rol, tema, ámbito (conjuntos) y módulos', me.data.role === 'owner' && me.data.settings?.tema && me.data.ambito?.etiqueta === 'Conjunto' && me.data.modules?.some((m) => m.id === 'cartera'), JSON.stringify(me.data).slice(0, 300));
  check('Los módulos centrales base (Inicio, Marca, IA) aparecen siempre', ['dashboard', 'marca', 'ai'].every((id) => me.data.modules.some((m) => m.id === id)), me.data.modules?.map((m) => m.id).join(','));
  check('/staff/ sin sesión redirige al ingreso', (await client()('/staff/')).status === 302);
  check('/ con sesión lleva al panel (/<dirección>)', (await app('/')).headers.get('location')?.endsWith(`/${slug}`));
  const panel = await app(`/${slug}`);
  check('/<dirección> con sesión sirve el panel con el marco de contenido', panel.status === 200 && panel.data.text?.includes('id="dw-frame"'), String(panel.status));
  const ingreso = await client()(`/${slug}`);
  check('/<dirección> sin sesión muestra el ingreso (no el panel)', ingreso.status === 200 && !ingreso.data.text?.includes('id="dw-frame"'));
  check('Una dirección que no es de ninguna administración da 404', (await app('/no-existe-xyz')).status === 404);
  check('El panel se puede cargar en un marco del mismo sitio', panel.headers.get('x-frame-options') === 'SAMEORIGIN');
  const doc = await app('/staff/cartera.html', { headers: { 'sec-fetch-dest': 'document' } });
  check('Una página abierta directo lleva al panel con ?go=', doc.status === 302 && doc.headers.get('location')?.includes(`/${slug}?go=`));
  check('La misma página pedida desde el marco responde', (await app('/staff/cartera', { headers: { 'sec-fetch-dest': 'iframe' } })).status === 200);
  check('/<dirección>/admin/cartera (enlace viejo) lleva al panel con la página', (await app(`/${slug}/admin/cartera`)).headers.get('location')?.includes('go=%2Fstaff%2Fcartera.html'));
  check('/admin/ (enlace viejo) lleva al panel', (await app('/admin/')).headers.get('location')?.includes(`/${slug}`));
  check('Escritura sin encabezado de seguridad se rechaza (CSRF)', (await app('/api/admin/properties', { method: 'POST', body: { name: 'x' }, headers: { 'x-app': '', 'x-cdr': '' } })).status === 403);
  for (const m of ['conjuntos', 'unidades', 'cartera', 'porteria', 'pqrs', 'reservas', 'mascotas', 'comunicados', 'ajustes', 'equipo', 'index']) {
    const r = await app(`/staff/${m === 'index' ? '' : m}`, { headers: { 'sec-fetch-dest': 'iframe' } });
    check(`Página /staff/${m} sirve y trae el shell`, r.status === 200 && r.data.text?.includes('id="dw-shell"') && r.data.text.includes('/js/residentes.js'), String(r.status));
  }

  // --- Conjuntos y unidades ---
  const P = await app('/api/admin/properties', { method: 'POST', body: { name: 'Altos del Parque', towers: 'Torre 1, Torre 2', city: 'Medellín' } });
  check('Crea un conjunto', P.status === 201 && P.data.id);
  const list = await app('/api/admin/properties');
  check('Lista los conjuntos con sus contadores', list.data.items?.length === 1 && list.data.items[0].units === 0);
  const U = await app('/api/admin/units', { method: 'POST', body: { property_id: P.data.id, tower: 'Torre 1', number: '502', owner_name: 'Ana Pérez', owner_doc: '1020304050', owner_phone: '3001112233' } });
  check('Crea una unidad', U.status === 201 && U.data.id, JSON.stringify(U.data));
  const ch = await app('/api/admin/charges', { method: 'POST', body: { unit_id: U.data.id, concept: 'admin', period: '2026-09', amount: 350000, due_date: '2026-09-10' } });
  check('Crea un cobro en la cartera de la unidad', ch.status === 201, JSON.stringify(ch.data));
  const sum = await app(`/api/admin/charges/summary?property=${P.data.id}`);
  check('Resumen de cartera: lo vencido aparece', sum.status === 200 && sum.data.overdue === 350000, JSON.stringify(sum.data).slice(0, 200));
  const dash = await app(`/api/admin/dashboard?property=${P.data.id}`);
  check('El dashboard del conjunto responde con la cartera', dash.status === 200 && dash.data.cartera?.debtors === 1);
  const sol = await app('/api/admin/requests', { method: 'POST', body: { property_id: P.data.id, kind: 'visita', title: 'Visita técnica' } });
  const pq = await app('/api/admin/pqrs', { method: 'POST', body: { property_id: P.data.id, subject: 'Ruido en la noche', kind: 'queja' } });
  check('Crea solicitud de portería y PQRS', sol.status === 201 && pq.status === 201);
  const pet = await app('/api/admin/pets', { method: 'POST', body: { unit_id: U.data.id, name: 'Rex', species: 'perro' } });
  check('Registra una mascota', pet.status === 201);

  // --- Aislamiento entre administraciones ---
  const B = await newBusiness('Admin B', { login: true });
  check('B no ve los conjuntos de A', (await B.app('/api/admin/properties')).data.items?.length === 0);
  check('B no ve las unidades de A', (await B.app('/api/admin/units')).data.items?.length === 0);
  check('B no puede leer una unidad de A', (await B.app(`/api/admin/units/${U.data.id}`)).status === 404);
  check('B no puede pagar un cobro de A', (await B.app(`/api/admin/charges/${ch.data.id}/pay`, { method: 'POST', body: {} })).status === 404);
  check('A sigue viendo lo suyo', (await app('/api/admin/units')).data.items?.length === 1);

  // --- Roles ---
  const S = await newMember(bid, 'staff');
  check('El equipo (staff) lee conjuntos', (await S.app('/api/admin/properties')).status === 200);
  check('El equipo (staff) no crea conjuntos (solo propietario o administrador)', (await S.app('/api/admin/properties', { method: 'POST', body: { name: 'Otro' } })).status === 403);
  const sme = (await S.app('/api/me')).data;
  check('El equipo no ve Finanzas, Marketing ni Nómina por defecto', !sme.modules.some((m) => ['finanzas', 'marketing', 'nomina'].includes(m.id)), sme.modules?.map((m) => m.id).join(','));
  check('El equipo no ve Ajustes (solo administradores)', !sme.modules.some((m) => m.id === 'ajustes'));

  // --- Módulos por administración (los asigna Diwilo) ---
  check('Diwilo lee el catálogo de módulos de la app', (await diwilo('GET', '/modules')).data.modulos?.some((m) => m.id === 'cartera'));
  check('Módulo desconocido se rechaza', (await diwilo('PUT', `/businesses/${bid}/modules`, { modules: [{ modulo: 'nada', activo: true }] })).status === 400);
  await diwilo('PUT', `/businesses/${bid}/modules`, { modules: [{ modulo: 'conjuntos', activo: true }, { modulo: 'unidades', activo: true }] });
  check('Módulo inactivo: su API responde 403', (await app('/api/admin/charges')).status === 403);
  check('Módulo inactivo: no aparece en el menú', !(await app('/api/me')).data.modules.some((m) => m.id === 'cartera'));
  check('Los conjuntos se pueden listar aunque otros módulos estén apagados', (await app('/api/admin/properties')).status === 200);
  check('Módulo inactivo en A no afecta a B', (await B.app('/api/admin/charges')).status === 200);
  await diwilo('PUT', `/businesses/${bid}/modules`, { modules: ['conjuntos', 'unidades', 'cartera', 'porteria', 'pqrs', 'reservas', 'mascotas', 'comunicados', 'ajustes'].map((modulo) => ({ modulo, activo: true })), version: 'h2' });
  check('Reactivado: los datos siguen ahí', (await app('/api/admin/charges')).status === 200);

  // --- Módulos centrales por el puente (Diwilo Modulos) ---
  const dsh = await app('/api/dashboard');
  check('Inicio (módulo central) responde con alertas e indicadores', dsh.status === 200 && Array.isArray(dsh.data.alertas) && Array.isArray(dsh.data.widgets), JSON.stringify(dsh.data).slice(0, 200));
  const mk = await app('/api/marca');
  check('Marca (módulo central) responde', mk.status === 200 && mk.data.marca?.tono, String(mk.status));
  const dp = await app('/staff/dashboard.html', { headers: { 'sec-fetch-dest': 'iframe' } });
  check('La página del Inicio central se arma con el shell de la app', dp.status === 200 && dp.data.text?.includes('/m/dashboard.js') && !dp.data.text.includes('/js/residentes.js'), `${dp.status} ${String(dp.data.text || JSON.stringify(dp.data)).slice(0, 150)}`);
  const dj = await app('/m/dashboard.js');
  check('El código del Inicio se sirve en /m/dashboard.js', dj.status === 200, `${dj.status} ${String(dj.data.text || '').slice(0, 100)}`);

  // --- Apariencia ---
  check('Apariencia: el propietario cambia el tema', (await app('/api/settings/apariencia', { method: 'PUT', body: { tema: 'verde', modo: 'dark' } })).data.tema === 'verde');
  check('Apariencia: el equipo no la cambia', (await S.app('/api/settings/apariencia', { method: 'PUT', body: { tema: 'rojo', modo: 'light' } })).status === 403);
  check('Apariencia: /api/me la devuelve', (await app('/api/me')).data.settings.tema === 'verde');

  // Logo de la administración (lo maneja Marca): un solo logo para el shell, el portal y la cuenta de cobro
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const lg = await app('/api/settings/logo', { method: 'PUT', body: { dataUrl: PNG } });
  check('Marca guarda el logo y /api/me lo entrega', lg.status === 200 && lg.data.logo && (await app('/api/me')).data.settings.logo, JSON.stringify(lg.data).slice(0, 120));
  check('El logo se puede leer en /api/settings/logo', (await app('/api/settings/logo')).status === 200);
  check('El mismo logo lo ve el resto de la app (/api/admin/business)', !!(await app('/api/admin/business')).data.business?.logo);
  check('El equipo no cambia el logo', (await S.app('/api/settings/logo', { method: 'PUT', body: { dataUrl: PNG } })).status === 403);

  // --- MCP / IA ---
  const tk = await app('/api/ia/tokens', { method: 'POST', body: { name: 'prueba' } });
  const token = tk.data.token;
  check('Crea un token de conexión MCP', tk.status === 201 && /^dwm_/.test(token || ''), JSON.stringify(tk.data).slice(0, 150));
  const tl = await mcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = (tl.data.result?.tools || []).map((t) => t.name);
  check('El MCP lista las herramientas de Residentes', names.includes('conjuntos_resumen_en_vivo') && names.includes('cartera_resumen_cartera') && names.includes('pqrs_listar_pqrs'), names.slice(0, 8).join(','));
  const call = await mcp(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'conjuntos_listar_conjuntos', arguments: {} } });
  check('Una herramienta de lectura devuelve los conjuntos', JSON.stringify(call.data).includes('Altos del Parque'), JSON.stringify(call.data).slice(0, 200));
  const wr = await mcp(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pqrs_responder_pqrs', arguments: { id: pq.data.id, status: 'in_progress', response: 'Estamos revisando' } } });
  check('Una herramienta de escritura usa la misma ruta de la API', !JSON.stringify(wr.data).includes('"isError":true'), JSON.stringify(wr.data).slice(0, 200));
  check('La escritura quedó en la bitácora', (await app('/api/settings/bitacora')).data.items?.length >= 1);

  // --- Portal de propietarios (sigue igual) ---
  check('El portal de propietarios sigue sirviendo su ingreso', (await client()(`/${slug}/portal/login`)).status === 200);
  const portal = await client()(`/api/public/portal/login`, { method: 'POST', body: { unit_id: U.id, doc: '1020304050' } });
  check('El portal responde (con o sin ese contrato) sin romperse', portal.status < 500, String(portal.status));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
console.log(failures() ? `\n✗ ${failures()} falla(s)` : '\nTodo bien');
process.exit(failures() ? 1 : 0);

// Comprobación visual rápida en un navegador real (solo local, no es parte de npm test): abre el panel, recorre los módulos y reporta
// errores de JavaScript, llamadas a la API que fallan y si cada pantalla pintó contenido.  CHROME=/ruta/a/chrome   PUPPETEER=/ruta/a/puppeteer-core
import { startApp, newBusiness, APP } from './test-helpers.mjs';
const puppeteer = (await import(process.env.PUPPETEER || '/Users/yomar/Vscode/Diwilo Web Admin/tools/smoke-panel/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js')).default;
await startApp();
const A = await newBusiness(`UI Admin ${Date.now()}`, { login: true });
const slug = A.created.data.slug;
// datos de ejemplo
const post = (p, b) => A.app(p, { method: 'POST', body: b });
const P = (await post('/api/admin/properties', { name: 'Altos del Parque', towers: 'Torre 1, Torre 2', city: 'Medellín' })).data.id;
await post('/api/admin/properties', { name: 'Bosques de la Sierra', city: 'Envigado' });
const U = (await post('/api/admin/units', { property_id: P, tower: 'Torre 1', number: '502', owner_name: 'Ana Pérez', owner_doc: '1020304050', owner_phone: '3001112233' })).data.id;
await post('/api/admin/charges', { unit_id: U, concept: 'admin', period: '2026-09', amount: 350000, due_date: '2026-09-10' });
await post('/api/admin/pqrs', { property_id: P, subject: 'Ruido', kind: 'queja' });
await post('/api/admin/requests', { property_id: P, kind: 'visita', title: 'Visita técnica' });

console.log('prueba directa /m/dashboard.js:', (await A.app('/m/dashboard.js')).status);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const problems = [];
try {
  for (const [vista, vp] of [['escritorio', { width: 1280, height: 800 }], ['celular', { width: 390, height: 800, isMobile: true }]]) {
    const page = await browser.newPage(); await page.setViewport(vp);
    const log = (m) => { if (!/favicon|fonts\.g|cdn\.jsdelivr|net::ERR/i.test(m)) problems.push(`${vista}: ${m}`); };
    page.on('pageerror', (e) => log(`pageerror ${String(e.message).slice(0, 200)}`));
    page.on('console', (m) => { if (m.type() === 'error') log(`console ${m.text().slice(0, 200)}`); });
    page.on('response', (r) => { if (r.url().startsWith(APP) && r.status() >= 400 && !/\/api\/(public|admin\/auth\/me)/.test(r.url())) log(`HTTP ${r.status()} ${r.url().replace(APP, '')}`); });
    await page.goto(`${APP}/`, { waitUntil: 'networkidle0' });
    await page.evaluate(async (mail) => { await fetch('/api/admin/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cdr': '1' }, body: JSON.stringify({ email: mail, password: 'clave-segura-1' }) }); }, A.mail);
    await page.goto(`${APP}/${slug}`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1500));
    const shell = await page.evaluate(() => ({ top: !!document.querySelector('.dw-top'), side: !!document.querySelector('.dw-side'), sede: !!document.querySelector('[data-sede-select]'), opts: document.querySelectorAll('[data-sede-select] option').length, menu: [...document.querySelectorAll('.dw-nav a[data-mod]')].map((a) => a.dataset.mod).join(',') }));
    console.log(vista, 'shell', JSON.stringify(shell));
    if (!shell.top || !shell.sede) problems.push(`${vista}: el shell no pintó (barra o selector de conjunto)`);
    const frame = () => page.frames().find((f) => f.parentFrame());
    const texto = async () => (await frame().evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 160);
    console.log(vista, 'inicio:', await texto());
    // elegir el primer conjunto desde la barra
    await page.select('[data-sede-select]', P);
    await new Promise((r) => setTimeout(r, 1500));
    console.log(vista, 'inicio con conjunto:', (await texto()).slice(0, 160), '|', (await frame().evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(200, 520));
    for (const mod of ['conjuntos', 'unidades', 'cartera', 'porteria', 'pqrs', 'mascotas', 'ajustes', 'equipo', 'finanzas', 'marketing', 'marca', 'ai', 'nomina']) {
      await page.evaluate((m) => { const a = document.querySelector(`.dw-nav a[data-mod="${m}"]`) || document.querySelector(`.dw-bottom a[data-mod="${m}"]`); if (a) a.click(); else document.getElementById('dw-frame').src = `/staff/${m}.html`; }, mod);
      await new Promise((r) => setTimeout(r, 2200));
      const t = await texto();
      console.log(vista, mod, '→', t.slice(0, 110));
      if (!t || /Cargando…$/.test(t) && t.length < 25) problems.push(`${vista}/${mod}: pantalla vacía o cargando`);
    }
    // Portería: pestañas Reservas (mes y semana) y Comunicados
    await page.evaluate(() => { document.getElementById('dw-frame').src = '/staff/porteria?tab=reservas'; });
    await new Promise((r) => setTimeout(r, 2500));
    await frame().evaluate(async (P) => {
      const h = { 'content-type': 'application/json', 'x-app': '1' };
      const hoy = new Date(); const d = (n) => { const x = new Date(hoy); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
      const z = await (await fetch('/api/admin/amenities', { method: 'POST', headers: h, body: JSON.stringify({ property_id: P, name: 'Salón ' + Date.now().toString(36), fee: 50000, fee_unit: 'dia' }) })).json();
      for (const [a, b, st] of [[0, 2, 'approved'], [4, 4, 'pending'], [6, 7, 'rejected']]) await fetch('/api/admin/bookings', { method: 'POST', headers: h, body: JSON.stringify({ amenity_id: z.id, date: d(a), end_date: b > a ? d(b) : '', start_time: '14:00', end_time: '18:00', status: st }) });
    }, P);
    await frame().evaluate(() => document.querySelector('#viewSw [data-view="month"]').click());
    await new Promise((r) => setTimeout(r, 1500));
    const cal = await frame().evaluate(() => ({ mes: document.querySelectorAll('#cal .mv .day').length, evs: document.querySelectorAll('#cal [data-ev]').length }));
    console.log(vista, 'reservas mes', JSON.stringify(cal));
    if (!cal.mes || !cal.evs) problems.push(`${vista}: el calendario de reservas (mes) no pintó`);
    await frame().evaluate(() => document.querySelector('#viewSw [data-view="week"]').click());
    await new Promise((r) => setTimeout(r, 1500));
    const sem = await frame().evaluate(() => ({ cols: document.querySelectorAll('#cal .wv .col').length, label: document.getElementById('rangeLabel').textContent }));
    console.log(vista, 'reservas semana', JSON.stringify(sem));
    if (sem.cols !== 7) problems.push(`${vista}: la vista de semana no pintó`);
    await frame().evaluate(() => document.querySelector('#mainTabs [data-pane="comunicados"]').click());
    await new Promise((r) => setTimeout(r, 1500));
    console.log(vista, 'comunicados →', (await texto()).slice(0, 90));
    await page.close();
  }
} finally { await browser.close(); }
console.log(problems.length ? `\nProblemas (${problems.length}):\n- ${[...new Set(problems)].join('\n- ')}` : '\nSin problemas');
process.exit(0);

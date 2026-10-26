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
    for (const mod of ['conjuntos', 'unidades', 'cartera', 'porteria', 'pqrs', 'reservas', 'mascotas', 'comunicados', 'ajustes', 'equipo', 'finanzas', 'marketing', 'marca', 'ai', 'nomina']) {
      await page.evaluate((m) => { const a = document.querySelector(`.dw-nav a[data-mod="${m}"]`) || document.querySelector(`.dw-bottom a[data-mod="${m}"]`); if (a) a.click(); else document.getElementById('dw-frame').src = `/staff/${m}.html`; }, mod);
      await new Promise((r) => setTimeout(r, 2200));
      const t = await texto();
      console.log(vista, mod, '→', t.slice(0, 110));
      if (!t || /Cargando…$/.test(t) && t.length < 25) problems.push(`${vista}/${mod}: pantalla vacía o cargando`);
    }
    await page.close();
  }
} finally { await browser.close(); }
console.log(problems.length ? `\nProblemas (${problems.length}):\n- ${[...new Set(problems)].join('\n- ')}` : '\nSin problemas');
process.exit(0);

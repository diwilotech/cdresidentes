// Service worker de la PWA (JS plano). Solo guarda el shell estático: CSS, JS, íconos y la pantalla de ingreso.
// NUNCA guarda /staff/*, /api/* ni /mcp: los datos siempre salen del servidor, para no romper el aislamiento
// por negocio ni mostrar datos viejos de otra sesión. Sin modo offline ni notificaciones push por ahora.
// Sube VERSION en cada cambio de archivos estáticos para que los celulares tomen la versión nueva.
const VERSION = 'cdr-v1';
const SHELL = ['/css/diwilo.css', '/css/residentes.css', '/js/app.js', '/js/crud.js', '/js/shell.js', '/js/residentes.js', '/icons/icon.svg', '/manifest.json'];
const PRIVATE = /^\/(staff|api|mcp)(\/|$)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || PRIVATE.test(url.pathname)) return; // red directa
  if (!SHELL.includes(url.pathname) && !/^\/(css|js|icons|assets)\//.test(url.pathname)) return;
  // Estáticos: responde con lo guardado y actualiza en segundo plano.
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(e.request);
    const fresh = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});

// Utilidades compartidas del panel. Cada página llama App.init('<seccion>').
'use strict';

const App = (() => {
  // Multi-tenant por ruta: el panel vive en /<slug>/admin y la API recibe el negocio en x-business.
  // El portal de propietarios vive en /<slug>/portal y usa /api/portal (las rutas /auth/* son comunes).
  const PORTAL = /^\/[a-z0-9-]+\/portal(?:\/|$)/.test(location.pathname);
  const API = PORTAL ? '/api/portal' : '/api/admin';
  const SLUG = (location.pathname.match(/^\/([a-z0-9-]+)\/(?:admin|portal)(?:\/|$)/) || [])[1] || null;
  const BASE = SLUG ? `/${SLUG}/admin` : '/admin';
  // Login: el del negocio (/<slug>/admin/login) o el genérico en la raíz "/".
  const LOGIN = SLUG ? `${BASE}/login` : '/';
  const PORTAL_LOGIN = `/${SLUG}/portal/login`;
  const onLogin = () => location.pathname === '/' || location.pathname.startsWith(`${BASE}/login`) || (PORTAL && location.pathname.startsWith(PORTAL_LOGIN));
  // Enlaces del panel con el negocio en la ruta: /admin/x -> /<slug>/admin/x (sin el 302 del servidor en cada clic).
  const link = (path) => (SLUG && /^\/(admin|portal)(\/|$|\?)/.test(path) && !path.startsWith('/admin/assets/') ? `/${SLUG}${path}` : path);
  const go = (path) => { location.href = link(path); };
  let me = null;
  let properties = [];
  const propertyListeners = [];

  // Tema claro/oscuro según el sistema.
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = () => document.documentElement.setAttribute('data-bs-theme', media.matches ? 'dark' : 'light');
  applyTheme();
  media.addEventListener('change', applyTheme);

  // Preferencias de este navegador (pueden no estar disponibles: modo privado, etc.).
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  };

  // ---------- formato ----------

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

  function fmtDate(iso, { weekday = false } = {}) {
    if (!iso) return '—';
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    const wd = weekday ? DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] + ' ' : '';
    return `${wd}${d} ${MESES[m - 1]} ${y}`;
  }
  const fmtTime = (iso) => (iso && iso.length >= 16 ? iso.slice(11, 16) : '');
  const fmtDateTime = (iso) => (iso ? `${fmtDate(iso, { weekday: true })}${fmtTime(iso) ? ' · ' + fmtTime(iso) : ''}` : '—');
  const fmtMonth = (ym) => (ym ? `${MESES_LARGOS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}` : '—');
  const fmtNum = (n, digits = 1) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('es-CO', { maximumFractionDigits: digits }));
  const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');
  // Cifras grandes abreviadas: $45,2 M
  const moneyShort = (n) => {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' mil M';
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' M';
    return money(v);
  };
  const unitLabel = (u) => [u.tower, u.number].filter(Boolean).join(' · ') || '—';
  const initials = (name) => (String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
  const daysSince = (iso) => (iso ? Math.max(0, Math.round((Date.parse(todayLocal()) - Date.parse(iso.slice(0, 10))) / 864e5)) : 0);

  function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  const ROLE = { owner: 'Propietario', admin: 'Administrador', staff: 'Equipo' };
  const KIND = { apartamento: 'Apartamento', casa: 'Casa', local: 'Local comercial', penthouse: 'Penthouse', parqueadero: 'Parqueadero', deposito: 'Depósito' };
  const OCCUPANCY = { owner: 'Propietario', tenant: 'Arrendada', vacant: 'Desocupada' };
  const CONCEPTS = {
    admin: 'Cuota de administración', rtc: 'Retroactivo', parking: 'Parqueadero', ext: 'Cuota extraordinaria',
    jur: 'Cobranza jurídica', int: 'Intereses de mora', other: 'Otro',
  };

  const badge = (text, cls = 'secondary') => `<span class="badge rounded-pill text-bg-${cls} bg-opacity-75">${esc(text)}</span>`;

  // Markdown mínimo y seguro para las respuestas del asistente (negritas, listas, títulos).
  function md(text) {
    const lines = esc(text).split('\n');
    let html = '';
    let list = null;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
        if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
        if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^#{1,4}\s+(.*)/))) {
        close(); html += `<p class="fw-bold mb-1">${inline(m[1])}</p>`;
      } else if (!line.trim()) {
        close();
      } else {
        close(); html += `<p>${inline(line)}</p>`;
      }
    }
    close();
    return html;
  }

  // Usuario y conjuntos de la sesión, guardados en la pestaña: el menú se dibuja al instante en cada página
  // y se confirma con el servidor en segundo plano.
  const SHELL_KEY = `cdr_shell_${SLUG || 'default'}`;
  const shellCache = {
    get() { try { return JSON.parse(sessionStorage.getItem(SHELL_KEY)); } catch { return null; } },
    set(v) { try { v ? sessionStorage.setItem(SHELL_KEY, JSON.stringify(v)) : sessionStorage.removeItem(SHELL_KEY); } catch { /* sin almacenamiento */ } },
  };
  // Al entrar o salir se borra el de todos los negocios.
  function clearShell() {
    try { Object.keys(sessionStorage).filter((k) => k.startsWith('cdr_shell_')).forEach((k) => sessionStorage.removeItem(k)); } catch { /* sin almacenamiento */ }
  }

  // ---------- barra de progreso ----------

  let inflight = 0;
  let barTimer;
  function progressBar() {
    let bar = document.getElementById('cdr-progress');
    if (!bar && document.body) {
      bar = document.createElement('div');
      bar.id = 'cdr-progress';
      document.body.appendChild(bar);
    }
    return bar;
  }
  function progress(delta) {
    inflight = Math.max(0, inflight + delta);
    clearTimeout(barTimer);
    const bar = progressBar();
    if (!bar) return;
    if (inflight) barTimer = setTimeout(() => bar.classList.add('on'), 150);  // solo si tarda
    else bar.classList.remove('on');
  }
  // Al seguir un enlace interno la barra arranca de una vez (la página siguiente puede tardar).
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('/admin') || href.startsWith('/portal')) a.setAttribute('href', link(href));
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || a.target === '_blank' || href.startsWith('#')) return;
    if (new URL(a.href).origin === location.origin && !a.href.includes('/api/')) progressBar()?.classList.add('on');
  });
  // Volver con el botón atrás (bfcache) no debe dejar la barra encendida.
  window.addEventListener('pageshow', () => { inflight = 0; document.getElementById('cdr-progress')?.classList.remove('on'); });

  // ---------- API ----------

  async function api(path, { method = 'GET', body, form } = {}) {
    const headers = { 'x-cdr': '1', ...(SLUG ? { 'x-business': SLUG } : {}) };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    progress(1);
    let res, data;
    try {
      const base = path.startsWith('/public/') ? '/api' : path.startsWith('/auth/') ? '/api/admin' : API;
      res = await fetch(base + path, { method, headers, body: payload, credentials: 'same-origin' });
      data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    } finally {
      progress(-1);
    }
    if (!res.ok) {
      if (['NO_SESSION', 'NOT_MEMBER', 'NO_BUSINESS'].includes(data?.code)) shellCache.set(null);
      // Portal: sin sesión (o sin unidades) vuelve al ingreso con apartamento y cédula.
      if (PORTAL && ['NO_SESSION', 'NOT_RESIDENT'].includes(data?.code) && !onLogin()) {
        location.href = `${PORTAL_LOGIN}?next=` + encodeURIComponent(location.pathname + location.search);
        return new Promise(() => {});
      }
      if (data?.code === 'NO_SESSION' && !onLogin()) {
        location.href = `${LOGIN}?next=` + encodeURIComponent(location.pathname + location.search);
        return new Promise(() => {});
      }
      if (['NOT_MEMBER', 'NOT_RESIDENT'].includes(data?.code) || (data?.code === 'NO_BUSINESS' && SLUG)) {
        location.href = '/admin/';  // a su propio negocio (lo resuelve el servidor)
        return new Promise(() => {});
      }
      const err = new Error(data?.error || `Error ${res.status}`);
      err.status = res.status;
      err.code = data?.code;
      throw err;
    }
    return data;
  }

  // Query string con el conjunto activo (si hay) y otros parámetros no vacíos.
  function qs(params = {}, { withProperty = true } = {}) {
    const p = new URLSearchParams();
    if (withProperty && currentProperty()) p.set('property', currentProperty());
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  // ---------- conjunto activo ----------

  const propKey = () => `cdr_property_${SLUG || 'default'}`;
  function currentProperty() {
    const active = properties.filter((p) => p.status === 'active');
    const id = store.get(propKey());
    if (id && active.some((p) => p.id === id)) return id;
    // Con un solo conjunto no hay nada que elegir.
    return active.length === 1 ? active[0].id : '';
  }
  const propertyName = (id) => properties.find((p) => p.id === id)?.name || '';
  function setProperty(id) {
    store.set(propKey(), id || null);
    document.querySelectorAll('[data-property-select]').forEach((s) => (s.value = id || ''));
    propertyListeners.forEach((fn) => fn(id || ''));
  }
  const onProperty = (fn) => propertyListeners.push(fn);

  // Selector de la barra superior: obliga a elegir un conjunto (no hay "todos") para no digitar en el equivocado.
  const topPropertyOptions = () => `<option value="" disabled ${currentProperty() ? '' : 'selected'}>Selecciona un conjunto</option>` + propertyOptions(currentProperty());
  function refreshPropertySelects() {
    document.querySelectorAll('[data-property-select]').forEach((s) => {
      s.innerHTML = topPropertyOptions();
      s.closest('.prop-pick')?.classList.toggle('need', !currentProperty());
    });
  }

  // <option> de conjuntos para formularios.
  const propertyOptions = (selected = currentProperty(), { blank = false } = {}) =>
    (blank ? `<option value="">${esc(blank === true ? 'Todos los conjuntos' : blank)}</option>` : '') +
    properties.filter((p) => p.status === 'active').map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  // ---------- UI ----------

  function toast(message, type = 'success') {
    let box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      box.className = 'toast-container position-fixed bottom-0 end-0 p-3';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${type === 'error' ? 'danger' : type} border-0`;
    el.setAttribute('role', 'status');
    el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Cerrar"></button></div>`;
    box.appendChild(el);
    const t = new bootstrap.Toast(el, { delay: type === 'error' ? 6000 : 3000 });
    el.addEventListener('hidden.bs.toast', () => el.remove());
    t.show();
  }

  const fail = (err) => toast(err.message || String(err), 'error');

  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else out[el.name] = el.value.trim();
    }
    return out;
  }

  function fillForm(form, data) {
    for (const el of form.elements) {
      if (!el.name || !(el.name in data)) continue;
      if (el.type === 'checkbox') el.checked = !!data[el.name];
      else if (el.type === 'radio') el.checked = el.value === String(data[el.name]);
      else el.value = data[el.name] ?? '';
    }
  }

  // Envuelve un submit: deshabilita el botón mientras corre y muestra errores.
  function onSubmit(form, handler) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!form.checkValidity()) {
        form.classList.add('was-validated');
        return;
      }
      const btn = form.querySelector('[type=submit]') || document.querySelector(`[form="${form.id}"][type=submit]`);
      if (btn) btn.disabled = true;
      try {
        await handler(formData(form), ev);
        form.classList.remove('was-validated');
      } catch (err) {
        fail(err);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  const confirmAction = async (message) => window.confirm(message);
  const param = (name) => new URLSearchParams(location.search).get(name);

  function modal(html, { size = '' } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'modal fade';
    wrap.tabIndex = -1;
    wrap.innerHTML = `<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable ${size}"><div class="modal-content">${html}</div></div>`;
    document.body.appendChild(wrap);
    const m = new bootstrap.Modal(wrap);
    wrap.addEventListener('hidden.bs.modal', () => wrap.remove());
    m.show();
    return { el: wrap, hide: () => m.hide() };
  }

  // Formulario en modal: fields = HTML de los campos. onSave(data) cierra al terminar.
  function formDialog({ title, fields, data = {}, submit = 'Guardar', size = '', onSave, extraFooter = '' }) {
    const { el, hide } = modal(`
      <form novalidate>
        <div class="modal-header"><h5 class="modal-title">${esc(title)}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
        <div class="modal-body">${fields}</div>
        <div class="modal-footer">${extraFooter}<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
          <button type="submit" class="btn btn-primary">${esc(submit)}</button></div>
      </form>`, { size });
    const form = el.querySelector('form');
    fillForm(form, data);
    onSubmit(form, async (d) => { await onSave(d, form); hide(); });
    return { el, form, hide };
  }

  // Muestra un link de invitación para copiarlo y enviarlo.
  function inviteDialog(url, title = 'Link de acceso') {
    const { el } = modal(`
      <div class="modal-header"><h5 class="modal-title">${esc(title)}</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
      <div class="modal-body">
        <p class="small text-body-secondary">Envíale este link a la persona. Al abrirlo crea su contraseña y entra. Sirve una sola vez.</p>
        <div class="input-group"><input class="form-control" readonly value="${esc(url)}">
          <button class="btn btn-outline-primary" type="button" data-copy><i class="bi bi-copy"></i></button></div>
      </div>`);
    el.querySelector('[data-copy]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); toast('Link copiado'); } catch { el.querySelector('input').select(); }
    });
  }

  // Enviar un mensaje (WhatsApp o correo) a una unidad, con borrador opcional de Diwilo AI.
  function messageDialog(unit, { text = '', aiCobro = false } = {}) {
    const people = [['owner', unit.owner_name || 'Propietario'], ...(unit.tenant_name ? [['tenant', unit.tenant_name]] : [])];
    const { el, form } = formDialog({
      title: `Mensaje · ${unitLabel(unit)}`,
      submit: 'Enviar',
      size: 'modal-lg',
      data: { text, channel: 'whatsapp', to: 'owner' },
      fields: `
        <div class="row g-2 mb-2">
          <div class="col-sm-6"><label class="form-label small">Para</label>
            <select name="to" class="form-select">${people.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select></div>
          <div class="col-sm-6"><label class="form-label small">Canal</label>
            <select name="channel" class="form-select"><option value="whatsapp">WhatsApp</option><option value="email">Correo</option></select></div>
        </div>
        <div class="d-flex justify-content-between align-items-end mb-1">
          <label class="form-label small mb-0">Mensaje</label>
          <button type="button" class="btn btn-sm btn-ai" data-ai><i class="bi bi-stars me-1"></i>Redactar cobro con IA</button>
        </div>
        <textarea name="text" class="form-control" rows="7" required maxlength="4000"></textarea>`,
      onSave: async (d) => {
        await api(`/units/${unit.id}/message`, { method: 'POST', body: d });
        toast('Mensaje enviado');
      },
    });
    const draft = async () => {
      const btn = el.querySelector('[data-ai]');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Redactando…';
      try {
        const r = await api('/ai/draft', { method: 'POST', body: { kind: 'cobro', unit_id: unit.id } });
        form.elements.text.value = r.text;
      } catch (err) { fail(err); }
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-stars me-1"></i>Redactar cobro con IA';
    };
    el.querySelector('[data-ai]').addEventListener('click', draft);
    if (aiCobro) draft();
  }

  // Adjuntos (R2) de un registro: lista + subir + borrar dentro de un contenedor.
  async function attachments(box, refType, refId) {
    async function load() {
      const { items } = await api(`/files${qs({ ref_type: refType, ref_id: refId }, { withProperty: false })}`);
      box.innerHTML = `
        <div class="d-flex flex-wrap gap-2 align-items-center">
          ${items.map((f) => `<span class="file-chip">
            <a href="/api/admin/files/${esc(f.id)}${SLUG ? `?b=${SLUG}` : ''}" target="_blank" rel="noopener"><i class="bi ${f.content_type === 'application/pdf' ? 'bi-file-earmark-pdf' : 'bi-image'} me-1"></i>${esc(f.name)}</a>
            <button type="button" class="btn btn-link btn-sm p-0 ms-1 text-danger" data-del-file="${esc(f.id)}" aria-label="Quitar"><i class="bi bi-x"></i></button></span>`).join('')}
          <label class="btn btn-sm btn-outline-secondary mb-0"><i class="bi bi-paperclip me-1"></i>Adjuntar
            <input type="file" class="d-none" accept="image/*,application/pdf"></label>
        </div>`;
    }
    box.addEventListener('change', async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        await api(`/files${qs({ ref_type: refType, ref_id: refId }, { withProperty: false })}`, { method: 'POST', form: fd });
        toast('Archivo adjuntado');
        await load();
      } catch (err) { fail(err); }
    });
    box.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-del-file]');
      if (!b || !(await confirmAction('¿Quitar este archivo?'))) return;
      try { await api(`/files/${b.dataset.delFile}`, { method: 'DELETE' }); await load(); } catch (err) { fail(err); }
    });
    await load().catch(fail);
  }

  // Llena el <select name="unit_id"> según el <select name="property_id"> del mismo formulario.
  function bindUnitSelect(form, { selected = '', blank = 'Sin unidad' } = {}) {
    const fill = async () => {
      const pid = form.elements.property_id.value;
      const { items } = pid ? await api('/units' + qs({ property: pid }, { withProperty: false })) : { items: [] };
      const cur = form.elements.unit_id.value || selected;
      form.elements.unit_id.innerHTML = (blank ? `<option value="">${esc(blank)}</option>` : '') +
        items.map((u) => `<option value="${esc(u.id)}" ${u.id === cur ? 'selected' : ''}>${esc(unitLabel(u))}${u.owner_name ? ' · ' + esc(u.owner_name) : ''}</option>`).join('');
    };
    form.elements.property_id.addEventListener('change', () => { form.elements.unit_id.value = ''; fill().catch(fail); });
    return fill().catch(fail);
  }

  // ---------- conceptos de cartera activos (Ajustes) ----------
  // Orden de la cuenta de cobro. La cuota de administración siempre está; las demás se activan en Ajustes.
  const CONCEPT_ORDER = ['admin', 'rtc', 'ext', 'parking', 'jur', 'int', 'other'];
  let billingReq;
  const billingInfo = () => (billingReq ||= api('/billing'));
  // Conceptos a mostrar: los activos + los desactivados que aún tienen saldo pendiente (para que los totales cuadren).
  async function shownConcepts() {
    const { billing, pending } = await billingInfo();
    return CONCEPT_ORDER.filter((k) => k === 'admin' || billing.concepts.includes(k) || pending[k] > 0);
  }
  // Conceptos que se pueden usar en cobros nuevos y liquidaciones.
  async function activeConcepts() {
    const { billing } = await billingInfo();
    return CONCEPT_ORDER.filter((k) => k === 'admin' || billing.concepts.includes(k));
  }

  // ---------- librerías bajo demanda ----------

  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const loaded = {};
  function loadScript(src) {
    return (loaded[src] ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src.startsWith('http') ? src : CDN + src;
      s.onload = resolve;
      s.onerror = () => { delete loaded[src]; reject(new Error('No se pudo cargar una librería. Revisa tu conexión.')); };
      document.head.appendChild(s);
    }));
  }
  function loadCss(href) {
    if (document.querySelector(`link[data-lib="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = CDN + href; l.dataset.lib = href;
    document.head.appendChild(l);
  }
  // pdfmake (PDF de cuentas de cobro y exportación de tablas): solo cuando se necesita.
  const loadPdf = async () => { await loadScript('pdfmake@0.2.23/build/pdfmake.min.js'); await loadScript('pdfmake@0.2.23/build/vfs_fonts.js'); };
  let dtReady;
  function loadDataTables() {
    return (dtReady ||= (async () => {
      ['datatables.net-bs5@2.3.8/css/dataTables.bootstrap5.min.css', 'datatables.net-buttons-bs5@3.2.6/css/buttons.bootstrap5.min.css',
        'datatables.net-responsive-bs5@3.0.8/css/responsive.bootstrap5.min.css'].forEach(loadCss);
      for (const src of ['jquery@3.7.1/dist/jquery.min.js', 'datatables.net@2.3.8/js/dataTables.min.js', 'datatables.net-bs5@2.3.8/js/dataTables.bootstrap5.min.js',
        'datatables.net-buttons@3.2.6/js/dataTables.buttons.min.js', 'datatables.net-buttons-bs5@3.2.6/js/buttons.bootstrap5.min.js',
        'datatables.net-buttons@3.2.6/js/buttons.html5.min.js', 'datatables.net-buttons@3.2.6/js/buttons.print.min.js', 'jszip@3.10.1/dist/jszip.min.js',
        'datatables.net-responsive@3.0.8/js/dataTables.responsive.min.js', 'datatables.net-responsive-bs5@3.0.8/js/responsive.bootstrap5.min.js']) await loadScript(src);
    })());
  }

  const DT_LANG = {
    decimal: ',', thousands: '.', emptyTable: 'Sin registros', info: '_START_ a _END_ de _TOTAL_', infoEmpty: '0 registros',
    infoFiltered: '(de _MAX_)', lengthMenu: '_MENU_ por página', loadingRecords: 'Cargando…', search: '', searchPlaceholder: 'Buscar…',
    zeroRecords: 'Sin resultados', paginate: { first: '«', last: '»', next: '›', previous: '‹' },
    buttons: { copy: 'Copiar', copyTitle: 'Copiado', copySuccess: { _: '%d filas copiadas', 1: '1 fila copiada' }, print: 'Imprimir' },
  };
  const plain = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' ').trim(); };

  // Tabla con búsqueda, orden, paginación, columnas adaptables al celular y descarga (Copiar, Excel, CSV, PDF, Imprimir).
  //   columns: [{ title, html(row) (lo que se ve), value(row) (orden/exportación; números sin formato),
  //               sum: true (total en el pie), money: true, noExport, exportOnly (oculta en pantalla), className, orderable, priority }]
  //   Se puede llamar de nuevo con el mismo <table> para reemplazar los datos.
  async function dataTable(table, { columns, data, order = [], title = document.title, pageLength = 25, rowId = 'id', onDraw } = {}) {
    await loadDataTables();
    const $ = window.jQuery;
    if (table._dt) {
      table._dt.clear().rows.add(data).draw(false);
      return table._dt;
    }
    if (columns.some((c) => c.sum)) table.insertAdjacentHTML('beforeend', `<tfoot><tr>${columns.map(() => '<th></th>').join('')}</tr></tfoot>`);
    const exportCols = columns.map((c, i) => (c.noExport ? -1 : i)).filter((i) => i >= 0);
    const fileTitle = `${title} ${todayLocal()}`;
    const ex = { columns: exportCols, orthogonal: 'export', footer: true };
    const dt = new DataTable(table, {
      data,
      rowId,
      order,
      pageLength,
      lengthMenu: [10, 25, 50, 100, { label: 'Todos', value: -1 }],
      language: { ...DT_LANG, lengthMenu: '_MENU_' },
      autoWidth: false,
      responsive: true,
      layout: {
        topStart: { buttons: [
          { extend: 'copy', text: '<i class="bi bi-clipboard"></i>', titleAttr: 'Copiar', exportOptions: ex, title: fileTitle },
          { extend: 'excel', text: '<i class="bi bi-file-earmark-excel"></i> Excel', exportOptions: ex, title: fileTitle, filename: fileTitle },
          { extend: 'csv', text: '<i class="bi bi-filetype-csv"></i> CSV', exportOptions: ex, filename: fileTitle },
          { extend: 'pdfHtml5', text: '<i class="bi bi-file-earmark-pdf"></i> PDF', exportOptions: ex, title: fileTitle, filename: fileTitle,
            orientation: exportCols.length > 6 ? 'landscape' : 'portrait', pageSize: 'LETTER',
            customize: (doc) => { doc.defaultStyle.fontSize = 8; doc.styles.tableHeader.fillColor = '#047857'; },
            // pdfmake se carga al usarlo por primera vez (sin esto DataTables oculta el botón).
            available: () => true,
            action: async function (e, dtApi, node, config, cb) {
              try { await loadPdf(); } catch (err) { fail(err); return; }
              DataTable.ext.buttons.pdfHtml5.action.call(this, e, dtApi, node, config, cb);
            } },
          { extend: 'print', text: '<i class="bi bi-printer"></i>', titleAttr: 'Imprimir', exportOptions: ex, title: fileTitle },
        ] },
        topEnd: ['pageLength', 'search'],
        bottomStart: 'info',
        bottomEnd: 'paging',
      },
      columns: columns.map((c, i) => ({
        title: c.title,
        data: null,
        className: [c.className, c.money || c.sum ? 'num' : ''].filter(Boolean).join(' '),
        orderable: c.orderable !== false,
        visible: !c.exportOnly,
        responsivePriority: c.priority ?? (i === 0 ? 1 : i === columns.length - 1 ? 2 : 10 + i),
        render: (_, type, row) => {
          if (type === 'display') return c.html ? c.html(row) : esc(c.value ? c.value(row) : '');
          const v = c.value ? c.value(row) : plain(c.html ? c.html(row) : '');
          return v ?? '';
        },
      })),
      footerCallback() {
        if (!columns.some((c) => c.sum)) return;
        const api = this.api();
        const rows = api.rows({ search: 'applied' }).data().toArray();
        columns.forEach((c, i) => {
          const cell = api.column(i).footer();
          if (!cell) return;
          if (i === 0) cell.textContent = `Total (${rows.length})`;
          else if (c.sum) cell.textContent = (c.money === false ? fmtNum : money)(rows.reduce((s, r) => s + (Number(c.value(r)) || 0), 0), 0);
          else cell.textContent = '';
        });
      },
      drawCallback() { onDraw?.(this.api()); },
    });
    table._dt = dt;
    return dt;
  }

  // Clic en una fila (sin abrir cuando se toca el botón de expandir del modo celular ni un botón/enlace).
  function onRowClick(table, fn) {
    table.addEventListener('click', (ev) => {
      if (ev.target.closest('button, a, input, .dtr-control, tr.child')) return;
      const tr = ev.target.closest('tbody tr[id]');
      if (tr) fn(tr.id);
    });
  }

  // ---------- navegación ----------

  const NAV = [
    ['Gestión principal', [
      ['inicio', '/admin/', 'bi-grid-1x2', 'Inicio'],
      ['conjuntos', '/admin/conjuntos', 'bi-buildings', 'Conjuntos'],
    ]],
    ['Módulos de propiedad', [
      ['unidades', '/admin/unidades', 'bi-people', 'Propietarios'],
      ['cartera', '/admin/cartera', 'bi-cash-stack', 'Cartera'],
      ['solicitudes', '/admin/solicitudes', 'bi-door-open', 'Portería'],
      ['pqrs', '/admin/pqrs', 'bi-chat-square-text', 'PQRS'],
      ['reservas', '/admin/reservas', 'bi-calendar2-week', 'Reservas'],
      ['mascotas', '/admin/mascotas', 'bi-heart', 'Mascotas'],
      ['comunicados', '/admin/comunicados', 'bi-megaphone', 'Comunicados'],
    ]],
    ['Inteligencia avanzada', [
      ['asistente', '/admin/asistente', 'bi-stars', 'Diwilo AI'],
      ['ajustes', '/admin/ajustes', 'bi-gear', 'Ajustes'],
    ]],
  ];
  const BOTTOM = ['inicio', 'unidades', 'cartera', 'asistente'];
  const BRAND_SVG = `<svg viewBox="18 14 168 172" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"><path d="M48 72V146Q48 170 72 170H84"/><path d="M156.6 135A70 70 0 0 0 96 30H86"/><path d="M84 134V124Q84 108 100 108H124"/></g><g fill="currentColor"><circle cx="48" cy="34" r="13"/><circle cx="112" cy="72" r="13"/><circle cx="125.6" cy="163.4" r="13"/></g></svg>`;

  function renderShell(active, { title } = {}) {
    const s = me.session || {};
    const all = NAV.flatMap(([, items]) => items);
    const sideHtml = `
      <a class="side-brand" href="${link('/admin/')}">
        <span class="side-logo">${s.businessLogo ? `<img src="${esc(s.businessLogo)}" alt="">` : BRAND_SVG}</span>
        <span><span class="d-block fw-bold">Diwilo</span><span class="side-sub">Residencial AI</span></span>
      </a>
      ${NAV.map(([label, items]) => `
        <div class="side-label">${esc(label)}</div>
        ${items.map(([key, href, icon, text]) => `<a class="side-link ${key === active ? 'active' : ''}" href="${link(href)}" ${key === active ? 'aria-current="page"' : ''}>
          <i class="bi ${icon}"></i><span>${text}</span>${key === 'asistente' ? '<span class="ai-dot"></span>' : ''}</a>`).join('')}`).join('')}
      <div class="side-foot">
        <div class="small fw-semibold text-truncate">${esc(s.businessName || '')}</div>
        <div class="small text-body-secondary text-truncate">${esc(me.name || me.email)} · ${esc(ROLE[s.role] || '')}</div>
      </div>`;

    const switcher = me.businesses.length > 1
      ? `<li><h6 class="dropdown-header">Cambiar de administración</h6></li>` +
        me.businesses.map((b) => `<li><button class="dropdown-item d-flex justify-content-between gap-3" data-business="${esc(b.id)}" data-slug="${esc(b.slug)}">
          <span>${esc(b.name)}</span>${b.id === s.businessId ? '<i class="bi bi-check2"></i>' : ''}</button></li>`).join('') +
        '<li><hr class="dropdown-divider"></li>'
      : '';

    const shell = document.createElement('div');
    shell.innerHTML = `
      <aside class="side d-none d-lg-flex">${sideHtml}</aside>
      <div class="offcanvas offcanvas-start side-off" tabindex="-1" id="sideMenu"><div class="offcanvas-body p-0 d-flex">
        <aside class="side d-flex position-static w-100">${sideHtml}</aside></div></div>
      <header class="topbar">
        <div class="top-start">
          <button class="btn btn-icon d-lg-none" data-bs-toggle="offcanvas" data-bs-target="#sideMenu" aria-label="Menú"><i class="bi bi-list"></i></button>
          <div class="top-title d-none d-md-block text-truncate">${esc(title || all.find(([k]) => k === active)?.[3] || '')}</div>
        </div>
        <label class="prop-pick ${currentProperty() ? '' : 'need'}">
          <i class="bi bi-buildings"></i>
          <select class="form-select form-select-sm" data-property-select aria-label="Conjunto activo">${topPropertyOptions()}</select>
        </label>
        <div class="top-end"><div class="dropdown">
          <button class="btn btn-icon dropdown-toggle no-caret" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Cuenta">
            <span class="avatar avatar-sm">${esc(initials(me.name || me.email))}</span></button>
          <ul class="dropdown-menu dropdown-menu-end shadow-sm">
            ${switcher}
            <li><span class="dropdown-item-text small text-body-secondary">${esc(me.name || '')}<br>${esc(me.email)} · ${esc(ROLE[s.role] || '')}</span></li>
            ${(me.portals || []).map((p) => `<li><a class="dropdown-item" href="/${esc(p.slug)}/portal/"><i class="bi bi-house-heart me-2"></i>Mi portal · ${esc(p.name)}</a></li>`).join('')}
            <li><button class="dropdown-item" data-action="change-password"><i class="bi bi-key me-2"></i>Cambiar contraseña</button></li>
            <li><button class="dropdown-item" data-action="logout"><i class="bi bi-box-arrow-right me-2"></i>Cerrar sesión</button></li>
          </ul>
        </div></div>
      </header>`;
    while (shell.firstChild) document.body.prepend(shell.lastChild);
    document.body.classList.add('has-side');
    // Con transiciones entre páginas (View Transitions) la animación la hace el navegador.
    if (!('onpagereveal' in window)) document.querySelector('main')?.classList.add('cdr-enter');
    document.querySelectorAll('a[href^="/admin"]').forEach((a) => a.setAttribute('href', link(a.getAttribute('href'))));

    // Barra inferior en celular.
    const bar = document.createElement('nav');
    bar.className = 'bottom-nav';
    bar.setAttribute('aria-label', 'Secciones');
    bar.innerHTML = BOTTOM.map((key) => {
      const [, href, icon, label] = all.find(([k]) => k === key);
      return `<a href="${link(href)}" class="${key === active ? 'active' : ''}"><i class="bi ${icon}"></i><span>${label}</span></a>`;
    }).join('') + `<button type="button" data-bs-toggle="offcanvas" data-bs-target="#sideMenu" class="${BOTTOM.includes(active) ? '' : 'active'}"><i class="bi bi-grid"></i><span>Más</span></button>`;
    document.body.appendChild(bar);
    document.body.classList.add('has-bottom-nav');

    setReadOnly(s.readOnly);

    document.querySelectorAll('[data-property-select]').forEach((sel) => sel.addEventListener('change', () => {
      // La página estaba esperando un conjunto: se carga de nuevo con el elegido.
      if (blocked) { store.set(propKey(), sel.value); location.reload(); return; }
      setProperty(sel.value);
      refreshPropertySelects();
      toast(`Trabajando en ${propertyName(sel.value)}`, 'primary');
    }));
    document.body.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-business]');
      if (b && b.closest('.dropdown-menu')) {
        try {
          await api('/auth/business', { method: 'POST', body: { businessId: b.dataset.business } });
          clearShell();
          location.href = `/${b.dataset.slug}/admin/`;
        } catch (err) { fail(err); }
        return;
      }
      const a = ev.target.closest('[data-action]');
      if (a?.dataset.action === 'logout') {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        clearShell();
        location.href = LOGIN;
      } else if (a?.dataset.action === 'change-password') {
        changePasswordDialog();
      }
    });
  }

  function setReadOnly(on) {
    let ro = document.querySelector('.readonly-bar');
    if (on && !ro) {
      ro = document.createElement('div');
      ro.className = 'alert alert-danger rounded-0 border-0 text-center small fw-semibold py-2 mb-0 readonly-bar';
      ro.innerHTML = '<i class="bi bi-lock-fill me-1"></i>La suscripción está vencida: puedes consultar, pero no guardar cambios.';
      document.querySelector('.topbar').after(ro);
    } else if (!on && ro) ro.remove();
  }

  function changePasswordDialog(mail = me.email) {
    formDialog({
      title: 'Cambiar contraseña',
      fields: `
        <input type="email" class="d-none" value="${esc(mail)}" autocomplete="username">
        <label class="form-label">Contraseña actual</label>
        <input name="currentPassword" type="password" class="form-control mb-3" required autocomplete="current-password">
        <label class="form-label">Contraseña nueva (mínimo 8 caracteres)</label>
        <input name="newPassword" type="password" minlength="8" class="form-control" required autocomplete="new-password">`,
      onSave: async (d) => {
        await api('/auth/change-password', { method: 'POST', body: d });
        toast('Contraseña actualizada');
      },
    });
  }

  function businessPicker() {
    const main = document.querySelector('main');
    const list = me.businesses
      .filter((b) => b.status === 'active')
      .map((b) => `<button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" data-business="${esc(b.id)}" data-slug="${esc(b.slug)}">
          <span><i class="bi bi-buildings me-2"></i>${esc(b.name)}</span><span class="badge text-bg-light">${esc(ROLE[b.role] || '')}</span></button>`)
      .join('');
    main.innerHTML = `
      <div class="card mx-auto mt-4" style="max-width:32rem"><div class="card-body p-4">
        <h1 class="h5 mb-3">¿A qué administración entras?</h1>
        ${list ? `<div class="list-group">${list}</div>` : '<p class="text-body-secondary mb-0">Tu correo no está asociado a ninguna administración activa.</p>'}
      </div></div>`;
    main.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-business]');
      if (!b) return;
      try {
        await api('/auth/business', { method: 'POST', body: { businessId: b.dataset.business } });
        clearShell();
        location.href = `/${b.dataset.slug}/admin/`;
      } catch (err) { fail(err); }
    });
  }

  const propsSig = (list) => JSON.stringify(list.map((p) => [p.id, p.name, p.status, p.logo]));

  async function fetchShell() {
    const fresh = await api('/auth/me');
    const props = fresh.session?.businessId ? (await api('/properties')).items : [];
    if (fresh.session) shellCache.set({ me: fresh, properties: props });
    return { fresh, props };
  }

  // Confirma con el servidor lo que se dibujó desde la caché y ajusta lo que haya cambiado.
  async function revalidate() {
    try {
      const { fresh, props } = await fetchShell();
      if (!fresh.session || fresh.session.businessId !== me.session.businessId || fresh.session.role !== me.session.role) {
        location.reload();
        return;
      }
      setReadOnly(fresh.session.readOnly);
      me = fresh;
      const changed = propsSig(props) !== propsSig(properties);
      properties = props;
      if (changed) refreshPropertySelects();
    } catch { /* sin conexión: queda lo de la caché */ }
  }

  // Precarga la página de un enlace del panel al pasar el mouse (Speculation Rules; Chrome y Edge).
  function prefetchLinks() {
    if (!SLUG || !HTMLScriptElement.supports?.('speculationrules')) return;
    const s = document.createElement('script');
    s.type = 'speculationrules';
    s.textContent = JSON.stringify({ prefetch: [{ where: { href_matches: `/${SLUG}/admin/*` }, eagerness: 'moderate' }] });
    document.head.appendChild(s);
  }

  // Devuelve la info del usuario o null si la página no debe continuar (falta negocio).
  async function init(active, { needsBusiness = true, title } = {}) {
    const cached = shellCache.get();
    if (cached?.me?.session) {
      // Se dibuja antes del primer pintado: el menú no parpadea al cambiar de página.
      me = cached.me;
      properties = cached.properties || [];
      renderShell(active, { title });
      revalidate();
    } else {
      const { fresh, props } = await fetchShell();
      me = fresh;
      if (!me.session) {
        location.href = `${LOGIN}?next=` + encodeURIComponent(location.pathname + location.search);
        return null;
      }
      properties = props;
      renderShell(active, { title });
    }
    prefetchLinks();
    if (needsBusiness && !me.session.businessId) {
      businessPicker();
      return null;
    }
    if (needsBusiness && !NO_PROPERTY.includes(active) && !currentProperty()) {
      propertyPicker();
      return null;
    }
    return me;
  }

  // Páginas que funcionan sin conjunto elegido; las demás piden uno antes de mostrar o guardar nada.
  const NO_PROPERTY = ['inicio', 'conjuntos', 'asistente', 'ajustes'];
  let blocked = false;
  function propertyPicker() {
    blocked = true;
    const main = document.querySelector('main');
    const active = properties.filter((p) => p.status === 'active');
    main.innerHTML = `
      <div class="mx-auto mt-3" style="max-width:56rem">
        <div class="eyebrow">Antes de continuar</div>
        <h1 class="page-title mb-1">Selecciona un conjunto</h1>
        <p class="page-sub mb-3">Todo lo que veas y registres en esta sección quedará en el conjunto que elijas.</p>
        <div class="row g-3">${active.map((p) => `
          <div class="col-md-6"><div class="card prop-card h-100" data-pick-prop="${esc(p.id)}"><div class="card-body d-flex gap-3 align-items-center">
            <div class="prop-logo">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : '<i class="bi bi-building"></i>'}</div>
            <div class="min-w-0"><div class="fw-bold text-truncate">${esc(p.name)}</div>
              <div class="small text-body-secondary">${p.units ?? 0} unidades${p.overdue ? ` · vencido ${moneyShort(p.overdue)}` : ''}</div></div>
            <i class="bi bi-chevron-right ms-auto text-body-secondary"></i></div></div></div>`).join('') ||
          `<div class="col-12"><div class="card"><div class="empty">Aún no hay conjuntos. <a href="${link('/admin/conjuntos?new=1')}">Crea el primero</a>.</div></div></div>`}</div>
      </div>`;
    main.addEventListener('click', (ev) => {
      const c = ev.target.closest('[data-pick-prop]');
      if (!c) return;
      store.set(propKey(), c.dataset.pickProp);
      location.reload();
    });
  }

  // ---------- portal de propietarios (/<slug>/portal) ----------
  // me = { user, business, units, concepts, billing, portals, isStaff, readOnly }

  const PORTAL_NAV = [
    ['inicio', '/portal/', 'bi-house', 'Inicio'],
    ['comunicados', '/portal/comunicados', 'bi-megaphone', 'Comunicados'],
    ['cartera', '/portal/cartera', 'bi-cash-stack', 'Mi cartera'],
    ['unidad', '/portal/unidad', 'bi-building', 'Mi unidad'],
    ['mascotas', '/portal/mascotas', 'bi-heart', 'Mascotas'],
    ['reservas', '/portal/reservas', 'bi-calendar2-week', 'Reservas'],
  ];
  const PORTAL_BOTTOM = ['inicio', 'cartera', 'reservas', 'comunicados'];
  const RELATION = { owner: 'Propietario', tenant: 'Residente' };
  const unitListeners = [];
  const unitKey = () => `cdr_unit_${SLUG || 'default'}`;
  // Unidad activa del portal (la persona puede tener varias).
  function currentUnit() {
    const units = me?.units || [];
    const id = store.get(unitKey());
    return units.some((u) => u.id === id) ? id : units[0]?.id || '';
  }
  const unitInfo = (id = currentUnit()) => (me?.units || []).find((u) => u.id === id) || null;
  function setUnit(id) {
    store.set(unitKey(), id);
    document.querySelectorAll('[data-unit-select]').forEach((s) => (s.value = id));
    unitListeners.forEach((fn) => fn(id));
  }
  const onUnit = (fn) => unitListeners.push(fn);

  function renderPortalShell(active) {
    const b = me.business;
    const u = unitInfo();
    const sideHtml = `
      <a class="side-brand" href="${link('/portal/')}">
        <span class="side-logo">${b.logo ? `<img src="${esc(b.logo)}" alt="">` : BRAND_SVG}</span>
        <span><span class="d-block fw-bold text-truncate" style="max-width:9rem">${esc(b.name)}</span><span class="side-sub">Portal de residentes</span></span>
      </a>
      <div class="side-label">Mi copropiedad</div>
      ${PORTAL_NAV.map(([key, href, icon, text]) => `<a class="side-link ${key === active ? 'active' : ''}" href="${link(href)}" ${key === active ? 'aria-current="page"' : ''}>
        <i class="bi ${icon}"></i><span>${text}</span></a>`).join('')}
      ${me.isStaff ? `<div class="side-label">Administración</div><a class="side-link" href="${link('/admin/')}"><i class="bi bi-speedometer2"></i><span>Ir al panel</span></a>` : ''}
      <div class="side-foot">
        <div class="small fw-semibold text-truncate">${esc(u ? `${u.label} · ${u.property_name}` : '')}</div>
        <div class="small text-body-secondary text-truncate">${esc(me.user.name || me.user.email || '')} · ${esc(RELATION[u?.relation] || '')}</div>
      </div>`;
    const unitPick = me.units.length > 1
      ? `<label class="prop-pick"><i class="bi bi-house-door"></i>
          <select class="form-select form-select-sm" data-unit-select aria-label="Unidad">${me.units.map((x) => `<option value="${esc(x.id)}" ${x.id === currentUnit() ? 'selected' : ''}>${esc(x.label)} · ${esc(x.property_name)}</option>`).join('')}</select></label>`
      : `<div class="prop-pick"><i class="bi bi-house-door"></i><span class="small fw-bold text-truncate pe-2">${esc(u ? `${u.label} · ${u.property_name}` : '')}</span></div>`;
    const others = (me.portals || []).filter((p) => p.slug !== SLUG);
    const shell = document.createElement('div');
    shell.innerHTML = `
      <aside class="side d-none d-lg-flex">${sideHtml}</aside>
      <div class="offcanvas offcanvas-start side-off" tabindex="-1" id="sideMenu"><div class="offcanvas-body p-0 d-flex">
        <aside class="side d-flex position-static w-100">${sideHtml}</aside></div></div>
      <header class="topbar">
        <div class="top-start">
          <button class="btn btn-icon d-lg-none" data-bs-toggle="offcanvas" data-bs-target="#sideMenu" aria-label="Menú"><i class="bi bi-list"></i></button>
          <div class="top-title d-none d-md-block text-truncate">${esc(PORTAL_NAV.find(([k]) => k === active)?.[3] || '')}</div>
        </div>
        ${unitPick}
        <div class="top-end"><div class="dropdown">
          <button class="btn btn-icon dropdown-toggle no-caret" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Cuenta">
            <span class="avatar avatar-sm">${esc(initials(me.user.name || me.user.email || '?'))}</span></button>
          <ul class="dropdown-menu dropdown-menu-end shadow-sm">
            ${others.length ? `<li><h6 class="dropdown-header">Otras copropiedades</h6></li>${others.map((p) => `<li><a class="dropdown-item" href="/${esc(p.slug)}/portal/">${esc(p.name)}</a></li>`).join('')}<li><hr class="dropdown-divider"></li>` : ''}
            <li><span class="dropdown-item-text small text-body-secondary">${esc(me.user.name || '')}<br>${esc(me.user.email || (u ? `Unidad ${u.label}` : ''))}</span></li>
            ${me.user.email ? '<li><button class="dropdown-item" data-action="change-password"><i class="bi bi-key me-2"></i>Cambiar contraseña</button></li>' : ''}
            <li><button class="dropdown-item" data-action="logout"><i class="bi bi-box-arrow-right me-2"></i>Cerrar sesión</button></li>
          </ul>
        </div></div>
      </header>`;
    while (shell.firstChild) document.body.prepend(shell.lastChild);
    document.body.classList.add('has-side', 'portal');
    if (!('onpagereveal' in window)) document.querySelector('main')?.classList.add('cdr-enter');
    document.querySelectorAll('a[href^="/portal"]').forEach((a) => a.setAttribute('href', link(a.getAttribute('href'))));

    const bar = document.createElement('nav');
    bar.className = 'bottom-nav';
    bar.setAttribute('aria-label', 'Secciones');
    bar.innerHTML = PORTAL_BOTTOM.map((key) => {
      const [, href, icon, label] = PORTAL_NAV.find(([k]) => k === key);
      return `<a href="${link(href)}" class="${key === active ? 'active' : ''}"><i class="bi ${icon}"></i><span>${label}</span></a>`;
    }).join('') + `<button type="button" data-bs-toggle="offcanvas" data-bs-target="#sideMenu" class="${PORTAL_BOTTOM.includes(active) ? '' : 'active'}"><i class="bi bi-grid"></i><span>Más</span></button>`;
    document.body.appendChild(bar);
    document.body.classList.add('has-bottom-nav');
    setReadOnly(me.readOnly);

    document.querySelectorAll('[data-unit-select]').forEach((sel) => sel.addEventListener('change', () => {
      setUnit(sel.value);
      const x = unitInfo();
      document.querySelectorAll('.side-foot .fw-semibold').forEach((el) => (el.textContent = x ? `${x.label} · ${x.property_name}` : ''));
    }));
    document.body.addEventListener('click', async (ev) => {
      const a = ev.target.closest('[data-action]');
      if (a?.dataset.action === 'logout') {
        await api('/public/portal/logout', { method: 'POST' }).catch(() => {});
        clearShell();
        location.href = PORTAL_LOGIN;
      } else if (a?.dataset.action === 'change-password') {
        changePasswordDialog(me.user.email);
      }
    });
  }

  async function initPortal(active) {
    const key = `cdr_shell_portal_${SLUG}`;
    let cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(key)); } catch { /* sin almacenamiento */ }
    const fetchMe = async () => {
      const fresh = await api('/me');
      try { sessionStorage.setItem(key, JSON.stringify(fresh)); } catch { /* sin almacenamiento */ }
      return fresh;
    };
    if (cached?.units?.length) {
      me = cached;
      renderPortalShell(active);
      fetchMe().then((fresh) => {
        const sig = (m) => JSON.stringify([m.units, m.business, m.isStaff]);
        if (sig(fresh) !== sig(me)) location.reload();
        else { me = fresh; setReadOnly(fresh.readOnly); }
      }).catch(() => {});
    } else {
      me = await fetchMe();
      renderPortalShell(active);
    }
    if (SLUG && HTMLScriptElement.supports?.('speculationrules')) {
      const sr = document.createElement('script');
      sr.type = 'speculationrules';
      sr.textContent = JSON.stringify({ prefetch: [{ where: { href_matches: `/${SLUG}/portal/*` }, eagerness: 'moderate' }] });
      document.head.appendChild(sr);
    }
    return me;
  }

  // Conceptos de cartera a mostrar en el portal: los activos + los que la unidad tenga con saldo.
  const portalConcepts = (pending = {}) => CONCEPT_ORDER.filter((k) => k === 'admin' || (me?.billing?.concepts || CONCEPT_ORDER).includes(k) || pending[k] > 0);

  const canManage = () => ['owner', 'admin'].includes(me?.session?.role);

  return {
    api, qs, init, initPortal, currentUnit, unitInfo, setUnit, onUnit, portalConcepts, RELATION, portal: PORTAL, link, go, clearShell, toast, dataTable, billingInfo, shownConcepts, activeConcepts, CONCEPT_ORDER, onRowClick, loadScript, loadPdf, bindUnitSelect, slug: SLUG, base: BASE, fail, esc, md, modal, formDialog, inviteDialog, messageDialog, attachments,
    onSubmit, formData, fillForm, confirmAction, param, badge, canManage,
    fmtDate, fmtTime, fmtDateTime, fmtMonth, fmtNum, money, moneyShort, unitLabel, initials, daysSince, todayLocal, addDays,
    currentProperty, setProperty, onProperty, propertyOptions, propertyName, refreshPropertySelects,
    ROLE, KIND, OCCUPANCY, CONCEPTS, MESES_LARGOS,
    get me() { return me; },
    get properties() { return properties; },
    set properties(v) {
      properties = v;
      const c = shellCache.get();
      if (c) shellCache.set({ ...c, properties: v });
    },
  };
})();

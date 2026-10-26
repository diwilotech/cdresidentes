// Utilidades compartidas del panel. Cada página llama App.init('<seccion>').
'use strict';

const R = (() => {
  // Páginas del panel del conjunto dentro del shell común (/staff): el menú, la barra y el tema los pone public/js/shell.js.
  // Este archivo solo trae lo que usan las páginas de los módulos: API, formatos, tablas, formularios y el conjunto activo.
  const API = '/api/admin';
  let SLUG = null;                       // dirección de la administración (la entrega /api/me)
  // Enlaces entre páginas del panel: lo viejo (/admin/cartera) apunta a la página del módulo (/staff/cartera.html)
  const PAGE = { conjuntos: 'conjuntos', unidades: 'unidades', cartera: 'cartera', solicitudes: 'porteria', porteria: 'porteria', pqrs: 'pqrs', reservas: 'reservas', mascotas: 'mascotas', comunicados: 'comunicados', ajustes: 'ajustes' };
  const link = (path) => {
    const m = /^\/admin(?:\/([a-z]+))?\/?(\?.*)?$/.exec(path);
    if (!m) return path;
    return m[1] && PAGE[m[1]] ? `/staff/${PAGE[m[1]]}.html${m[2] || ''}` : `/staff/${m[2] || ''}`;
  };
  const go = (path) => { location.href = link(path); };
  let me = null;
  let properties = [];
  const propertyListeners = [];

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

  const clearShell = () => {};

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
    if (href.startsWith('/admin') && !href.startsWith('/admin/assets')) a.setAttribute('href', link(href));
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || a.target === '_blank' || href.startsWith('#')) return;
    if (new URL(a.href).origin === location.origin && !a.href.includes('/api/')) progressBar()?.classList.add('on');
  });
  // Volver con el botón atrás (bfcache) no debe dejar la barra encendida.
  window.addEventListener('pageshow', () => { inflight = 0; document.getElementById('cdr-progress')?.classList.remove('on'); });

  // ---------- API ----------

  async function api(path, { method = 'GET', body, form } = {}) {
    const headers = { 'x-cdr': '1' };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    progress(1);
    let res, data;
    try {
      const base = path.startsWith('/public/') ? '/api' : API;
      res = await fetch(base + path, { method, headers, body: payload, credentials: 'same-origin' });
      data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    } finally {
      progress(-1);
    }
    if (!res.ok) {
      if (['NO_SESSION', 'NOT_MEMBER', 'NO_BUSINESS'].includes(data?.code)) { (window.top || window).location.replace('/'); return new Promise(() => {}); }
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

  const propKey = () => `cdr_property_${SLUG || 'default'}`;   // la misma llave que usa el selector del shell
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
    // Avisa al panel (selector de la barra superior) y a las demás páginas abiertas
    try { window.parent.postMessage({ dw: 'sede', id: id || '' }, location.origin); } catch (_) { /* sin panel */ }
  }
  const onProperty = (fn) => propertyListeners.push(fn);

  const refreshPropertySelects = () => document.querySelectorAll('[data-property-select]').forEach((sel) => { sel.value = currentProperty(); });

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

  const setReadOnly = () => {};   // la barra roja de solo lectura la pone el shell

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

  // Devuelve la info del usuario o null si la página no debe continuar (falta elegir un conjunto).
  async function init(active, { needsBusiness = true } = {}) {
    const dw = await window.DW.ready;
    SLUG = dw.business.slug;
    me = {
      userId: dw.user.id, email: dw.user.email, name: dw.user.name,
      session: { businessId: dw.business.id, businessName: dw.business.name, businessSlug: dw.business.slug, role: dw.role, readOnly: dw.business.readOnly, paidUntil: dw.business.paidUntil },
      businesses: dw.businesses || [], portals: [],
    };
    properties = (await api('/properties')).items;
    // El selector de conjunto está en la barra del panel: si lo cambian ahí, esta página se carga de nuevo con el elegido.
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== window.parent || e.data?.dw !== 'sede') return;
      if (blocked) { store.set(propKey(), e.data.id || null); location.reload(); return; }
      setProperty(e.data.id);
      refreshPropertySelects();
    });
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

  const canManage = () => ['owner', 'admin'].includes(me?.session?.role);

  return {
    api, qs, init, link, go, clearShell, toast, dataTable, billingInfo, shownConcepts, activeConcepts, CONCEPT_ORDER, onRowClick, loadScript, loadPdf, bindUnitSelect, fail, esc, md, modal, formDialog, inviteDialog, messageDialog, attachments,
    onSubmit, formData, fillForm, confirmAction, param, badge, canManage,
    fmtDate, fmtTime, fmtDateTime, fmtMonth, fmtNum, money, moneyShort, unitLabel, initials, daysSince, todayLocal, addDays,
    currentProperty, setProperty, onProperty, propertyOptions, propertyName, refreshPropertySelects,
    ROLE, KIND, OCCUPANCY, CONCEPTS, MESES_LARGOS,
    get slug() { return SLUG; },
    get me() { return me; },
    get properties() { return properties; },
    set properties(v) {
      properties = v;
      // El selector de la barra del panel toma la lista nueva (conjunto creado, renombrado o archivado)
      try { window.parent.postMessage({ dw: 'sedes' }, location.origin); } catch (_) { /* sin panel */ }
    },
  };
})();
window.Res = R;
// Las páginas de los módulos de Residentes usan App.*. El Inicio (y las páginas de los módulos centrales, que usan el App común) lo conservan.
if (!window.DW_KEEP_APP) window.App = R;

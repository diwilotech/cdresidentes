// Utilidades comunes del navegador (login y páginas del negocio). Igual en todas las apps de Diwilo.
//   App.api(path, { method, body })   fetch a la API; las escrituras llevan x-app: 1 (CSRF)
//   App.toast(msg, ok)                aviso corto (toast de Bootstrap)
//   App.confirm({ title, text, ok })  modal de confirmación -> Promise<boolean> (antes de borrar)
//   App.empty(icon, text, actionHtml) estado vacío con ícono y acción sugerida
//   App.table(columns, rows)          tabla que en celular se vuelve tarjetas
//   App.kpi({ titulo, valor, detalle, icono, ruta })
//   App.changePassword()              ventana para cambiar la contraseña
(function () {
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(method !== 'GET' ? { 'x-app': '1' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.code === 'NO_SESSION' && location.pathname.startsWith('/staff')) (window.top || window).location.replace('/');
    if (!res.ok) {
      const err = new Error(data.error || `Error ${res.status}`);
      err.status = res.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const fecha = (iso, withTime = false) => iso ? new Date(iso).toLocaleString('es-CO', withTime ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  function toast(msg, ok = true) {
    let box = document.querySelector('.dw-toasts');
    if (!box) { box = document.createElement('div'); box.className = 'dw-toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = `toast align-items-center border-0 show text-bg-${ok ? 'dark' : 'danger'}`;
    el.setAttribute('role', ok ? 'status' : 'alert');
    el.innerHTML = `<div class="d-flex"><div class="toast-body"><i class="bi ${ok ? 'bi-check-circle' : 'bi-exclamation-triangle'} me-2"></i>${esc(msg)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" aria-label="Cerrar"></button></div>`;
    el.querySelector('.btn-close').onclick = () => el.remove();
    box.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // Modal reutilizable (Bootstrap). Devuelve el elemento y la instancia.
  function modal(html, { size = '' } = {}) {
    const el = document.createElement('div');
    el.className = 'modal fade';
    el.tabIndex = -1;
    el.innerHTML = `<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable ${size}"><div class="modal-content">${html}</div></div>`;
    document.body.appendChild(el);
    const m = new bootstrap.Modal(el);
    el.addEventListener('hidden.bs.modal', () => el.remove());
    m.show();
    return { el, m };
  }

  function confirm({ title = '¿Seguro?', text = '', ok = 'Borrar', danger = true } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      const { el, m } = modal(`<div class="modal-header border-0 pb-0"><h2 class="modal-title h5">${esc(title)}</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
        <div class="modal-body pt-2">${text ? `<p class="mb-0 text-body-secondary">${esc(text)}</p>` : ''}</div>
        <div class="modal-footer border-0 pt-0"><button type="button" class="btn btn-light" data-bs-dismiss="modal">Cancelar</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(ok)}</button></div>`);
      el.querySelector('[data-ok]').onclick = () => { answered = true; resolve(true); m.hide(); };
      el.addEventListener('hidden.bs.modal', () => { if (!answered) resolve(false); });
    });
  }

  const empty = (icon, text, action = '') => `<div class="dw-empty"><i class="bi ${esc(icon)}"></i><p>${esc(text)}</p>${action}</div>`;

  // columns: [{ label, html: (row) => string, main?: true, cls? }]
  const table = (columns, rows) => `<div class="table-responsive-md"><table class="table dw-table align-middle mb-0"><thead><tr>${columns.map((c) => `<th class="${c.cls || ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td data-label="${esc(c.label)}" class="${c.main ? 'dw-td-main ' : ''}${c.cls || ''}">${c.html(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  const kpi = (w) => {
    const tag = w.ruta ? 'a' : 'div';
    return `<${tag} class="dw-card dw-kpi" ${w.ruta ? `href="${esc(w.ruta)}"` : ''}><span class="dw-kpi__icon"><i class="bi ${esc(w.icono || 'bi-graph-up')}"></i></span>
      <span><span class="dw-kpi__v d-block">${esc(w.valor ?? '—')}</span><span class="dw-kpi__l d-block">${esc(w.titulo || '')}</span>${w.detalle ? `<span class="dw-kpi__d d-block">${esc(w.detalle)}</span>` : ''}</span></${tag}>`;
  };

  function changePassword() {
    const { el, m } = modal(`<form class="needs-validation" novalidate><div class="modal-header border-0 pb-0"><h2 class="modal-title h5">Cambiar contraseña</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
      <div class="modal-body d-grid gap-2">
        <input class="form-control" type="password" name="current" placeholder="Contraseña actual" autocomplete="current-password" required>
        <input class="form-control" type="password" name="password" placeholder="Nueva contraseña (mínimo 8)" minlength="8" maxlength="200" autocomplete="new-password" required>
        <input class="form-control" type="password" name="confirm" placeholder="Repite la nueva contraseña" minlength="8" maxlength="200" autocomplete="new-password" required>
        <div class="small text-danger" data-err></div></div>
      <div class="modal-footer border-0 pt-0"><button type="button" class="btn btn-light" data-bs-dismiss="modal">Cancelar</button><button class="btn btn-primary">Guardar</button></div></form>`);
    const f = el.querySelector('form'), err = el.querySelector('[data-err]');
    f.onsubmit = async (e) => {
      e.preventDefault();
      f.classList.add('was-validated');
      if (!f.checkValidity()) return;
      if (f.password.value !== f.confirm.value) { err.textContent = 'Las contraseñas nuevas no coinciden'; return; }
      try {
        await api('/api/auth/password', { method: 'POST', body: { current: f.current.value, password: f.password.value } });
        m.hide();
        toast('Contraseña actualizada. Se cerraron tus otras sesiones.');
      } catch (ex) { err.textContent = ex.message; }
    };
  }

  // PWA: el service worker solo guarda archivos estáticos (nunca /staff ni /api).
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

  window.App = { api, esc, fecha, toast, modal, confirm, empty, table, kpi, changePassword };
})();

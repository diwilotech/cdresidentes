// Componentes de datos comunes (los usan Finanzas, Marketing y los módulos propios): tabla con buscar, filtros,
// crear y editar en ventana, referencias entre entidades, KPIs, barras, medidores y ranking. Bootstrap + tema.
//   const t = App.Crud.table({ el, base: '/api/finanzas', entity: 'movements', title: 'movimiento', newText: 'Nuevo movimiento',
//     fields: [...], columns: [{ label, html: (row, R) => '', main?, cls? }], filters: [{ k, options: [[v, label]] }], refs: ['accounts'] });
//   t.load();
(function () {
  const { api, esc, toast, confirm } = window.App;
  const money = (n) => (n == null ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('es-CO'));
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString('es-CO'));
  const pct = (n) => (n == null ? '—' : `${n}%`);
  const day = (iso) => (iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const monthName = (ym) => `${MESES[+String(ym).slice(5, 7) - 1]} ${String(ym).slice(2, 4)}`;
  const todayCo = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  const chip = (tone, text) => `<span class="badge rounded-pill text-bg-${{ ok: 'success', soon: 'warning', bad: 'danger', free: 'secondary' }[tone] || 'light'}">${esc(text)}</span>`;

  // ---- referencias (nombres de cuentas, campañas, contactos…) ----
  const cache = {};
  const LABEL = { campaigns: 'name', contacts: 'name', cost_centers: 'name', accounts: 'name', deals: 'title', invoices: 'number', lists: 'name' };
  const refs = (base, entity, force) => {
    const k = `${base}/${entity}`;
    if (!cache[k] || force) cache[k] = api(`${base}/${entity}?limit=1000`).then((d) => d.rows).catch(() => []);
    return cache[k];
  };
  const dropRefs = (base, entity) => { delete cache[`${base}/${entity}`]; };
  const refName = (R, ent, id, key) => (id ? esc((R[ent]?.find((x) => x.id === id) || {})[key || LABEL[ent] || 'name'] || R[ent]?.find((x) => x.id === id)?.nombre || `#${id}`) : '<span class="text-body-secondary">—</span>');

  // ---- formulario en ventana ----
  // fields: [{ k, label, type: text|long|email|url|date|month|money|usd|int|bool|select, options, ref, full, hint, placeholder, required, check, default, empty }]
  function form({ title, fields, values = {}, base, okText = 'Guardar', onDelete }) {
    return new Promise(async (resolve) => {
      const lists = {};
      for (const f of fields.filter((x) => x.ref)) lists[f.ref] = await refs(base, f.ref);
      const input = (f) => {
        const v = values[f.k] ?? f.default ?? '';
        const req = f.required ? 'required' : '';
        const id = `f_${f.k}`;
        if (f.type === 'long') return `<textarea class="form-control" id="${id}" name="${f.k}" rows="3" ${req}>${esc(v)}</textarea>`;
        if (f.type === 'bool') return `<div class="form-check form-switch mt-1"><input class="form-check-input" type="checkbox" id="${id}" name="${f.k}" ${v ? 'checked' : ''}><label class="form-check-label" for="${id}">${esc(f.check || 'Sí')}</label></div>`;
        if (f.type === 'select' || f.ref) {
          const opts = f.ref ? [['', f.empty || '—'], ...lists[f.ref].map((r) => [r.id, r[LABEL[f.ref] || 'name'] || r.nombre || r.titulo || `#${r.id}`])] : f.options;
          return `<select class="form-select" id="${id}" name="${f.k}" ${req}>${opts.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
        }
        const type = { date: 'date', month: 'month', money: 'number', usd: 'number', int: 'number', email: 'email', url: 'url' }[f.type] || 'text';
        const extra = f.type === 'money' ? 'min="0" step="1" inputmode="numeric"' : f.type === 'usd' ? 'min="0" step="0.01" inputmode="decimal"' : f.type === 'int' ? 'step="1" inputmode="numeric"' : '';
        return `<input class="form-control" type="${type}" id="${id}" name="${f.k}" value="${esc(v)}" ${extra} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${req}>`;
      };
      const { el, m } = window.App.modal(`<form class="needs-validation" novalidate>
        <div class="modal-header border-0 pb-0"><h2 class="modal-title h5">${esc(title)}</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button></div>
        <div class="modal-body"><div class="row g-2">${fields.map((f) => `<div class="${f.full || f.type === 'long' ? 'col-12' : 'col-sm-6'}"><label class="form-label small mb-1" for="f_${f.k}">${esc(f.label)}${f.hint ? ` <span class="text-body-secondary">· ${esc(f.hint)}</span>` : ''}</label>${input(f)}</div>`).join('')}</div>
          <div class="small text-danger mt-2" data-err></div></div>
        <div class="modal-footer border-0 pt-0 justify-content-between"><span>${onDelete ? '<button type="button" class="btn btn-outline-danger btn-sm" data-del><i class="bi bi-trash me-1"></i>Borrar</button>' : ''}</span>
          <span><button type="button" class="btn btn-light" data-bs-dismiss="modal">Cancelar</button> <button class="btn btn-primary">${esc(okText)}</button></span></div></form>`, { size: 'modal-lg' });
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); m.hide(); };
      el.addEventListener('hidden.bs.modal', () => { if (!done) { done = true; resolve(null); } });
      el.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!(await confirm({ title: '¿Borrar este registro?', text: 'No se puede deshacer. Queda en la bitácora.' }))) return;
        try { await onDelete(); finish('deleted'); } catch (x) { el.querySelector('[data-err]').textContent = x.message; }
      });
      const f = el.querySelector('form');
      f.onsubmit = (e) => {
        e.preventDefault();
        f.classList.add('was-validated');
        if (!f.checkValidity()) return;
        const out = {};
        for (const fd of fields) { const x = f.elements[fd.k]; out[fd.k] = fd.type === 'bool' ? x.checked : x.value.trim(); }
        finish(out);
      };
      setTimeout(() => f.querySelector('input:not([type=checkbox]), select, textarea')?.focus(), 250);
    });
  }

  // ---- tabla de una entidad con buscar, filtros, crear, editar y borrar ----
  // cfg: { el, base, entity, title, newText, columns, fields, filters, refs, rowActions(row), onAction(name, row, btn), defaults(), onChanged(),
  //        onEdit(row, changed), extraButtons, readOnly, canDelete, empty, fixed: { campo: valor } }
  function table(cfg) {
    const host = document.createElement('div');
    cfg.el.replaceChildren(host);
    const st = { q: '', f: {}, rows: [] };
    const R = {};
    const me = window.DW?.me;
    const readOnlyApp = me?.business?.readOnly;
    host.innerHTML = `<div class="d-flex flex-wrap gap-2 align-items-center mb-2">
        <input class="form-control" data-q placeholder="Buscar…" style="max-width:240px" aria-label="Buscar">
        ${(cfg.filters || []).map((f) => `<select class="form-select w-auto" data-f="${f.k}" aria-label="Filtro">${f.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`).join('')}
        <span class="flex-grow-1"></span>${cfg.extraButtons || ''}
        ${cfg.readOnly ? '' : `<button class="btn btn-primary" data-new ${readOnlyApp ? 'disabled' : ''}><i class="bi bi-plus-lg me-1"></i>${esc(cfg.newText || 'Nuevo')}</button>`}</div>
      <div class="dw-card p-0 p-md-2" data-body><div class="p-3 text-body-secondary">Cargando…</div></div>`;
    const base = () => `${cfg.base}/${cfg.entity}`;
    async function load() {
      const qs = new URLSearchParams({ q: st.q });
      for (const [k, v] of Object.entries({ ...st.f, ...(cfg.fixed || {}) })) if (v !== '' && v != null) qs.set('f_' + k, v);
      try {
        const [d] = await Promise.all([api(`${base()}?${qs}`), ...(cfg.refs || []).map(async (r) => { R[r] = await refs(cfg.base, r); })]);
        st.rows = d.rows;
        host.querySelector('[data-body]').innerHTML = st.rows.length ? `<div class="table-responsive-md"><table class="table dw-table align-middle mb-0 dw-clickable"><thead><tr>${cfg.columns.map((c) => `<th class="${c.cls || ''}">${esc(c.label)}</th>`).join('')}${cfg.rowActions ? '<th></th>' : ''}</tr></thead>
          <tbody>${st.rows.map((r) => `<tr data-id="${r.id}">${cfg.columns.map((c) => `<td data-label="${esc(c.label)}" class="${c.main ? 'dw-td-main ' : ''}${c.cls || ''}">${c.html(r, R)}</td>`).join('')}${cfg.rowActions ? `<td data-label="" class="text-end text-nowrap" data-stop>${cfg.rowActions(r)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`
          : window.App.empty(cfg.emptyIcon || 'bi-inbox', cfg.empty || 'Aún no hay registros.');
      } catch (x) { host.querySelector('[data-body]').innerHTML = `<div class="p-3 text-danger">${esc(x.message)}</div>`; }
    }
    function changed() { dropRefs(cfg.base, cfg.entity); load(); cfg.onChanged?.(); }
    async function edit(row) {
      if (cfg.onEdit) return cfg.onEdit(row, changed);
      if (readOnlyApp) return;
      const canDel = cfg.canDelete ?? !!me?.canManage;
      const out = await form({ title: row ? `Editar ${cfg.title}` : (cfg.newText || 'Nuevo'), fields: cfg.fields, values: row ? { ...row } : { ...(cfg.defaults?.() || {}) }, base: cfg.base,
        onDelete: row && canDel ? () => api(`${base()}/${row.id}`, { method: 'DELETE' }) : null });
      if (out === 'deleted') { toast('Borrado'); changed(); return; }
      if (!out) return;
      try {
        await api(row ? `${base()}/${row.id}` : base(), { method: row ? 'PATCH' : 'POST', body: row ? out : { ...out, ...(cfg.fixed || {}) } });
        toast(row ? 'Guardado' : 'Creado'); changed();
      } catch (x) { toast(x.message, false); }
    }
    let t;
    host.querySelector('[data-q]').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); load(); }, 250); });
    host.querySelectorAll('[data-f]').forEach((s) => s.addEventListener('change', () => { st.f[s.dataset.f] = s.value; load(); }));
    host.querySelector('[data-new]')?.addEventListener('click', () => edit(null));
    host.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const row = st.rows.find((r) => String(r.id) === tr.dataset.id);
      const act = e.target.closest('[data-act]');
      if (act) { cfg.onAction?.(act.dataset.act, row, act); return; }
      if (e.target.closest('[data-stop], a, input, button, select')) return;
      if (!cfg.readOnly) edit(row); else cfg.onOpen?.(row);
    });
    return { load, edit, rows: () => st.rows };
  }

  // ---- gráficos y piezas del resumen ----
  // separate: cada serie con su propia escala (p. ej. gasto en pesos vs número de leads)
  function bars(el, rows, { a = 'a', b = 'b', la = 'A', lb = 'B', fmt = money, separate = false } = {}) {
    if (!rows.length) { el.innerHTML = '<p class="text-body-secondary mb-0">Sin datos todavía.</p>'; return; }
    const maxA = Math.max(1, ...rows.map((r) => r[a])), maxB = Math.max(1, ...rows.map((r) => r[b])), max = Math.max(maxA, maxB);
    const hA = (r) => (r[a] / (separate ? maxA : max) * 100).toFixed(1), hB = (r) => (r[b] / (separate ? maxB : max) * 100).toFixed(1);
    el.innerHTML = `<div class="dw-bars">${rows.map((r) => `<div class="dw-bar${r.projected ? ' dw-bar--proj' : ''}" title="${esc(r.label)} · ${esc(la)}: ${esc(fmt(r[a]))} · ${esc(lb)}: ${esc(fmt(r[b]))}${r.projected ? ' (proyectado)' : ''}">
        <div class="dw-bar__c"><i class="dw-a" style="height:${hA(r)}%"></i><i class="dw-b" style="height:${hB(r)}%"></i></div><span>${esc(r.label)}</span></div>`).join('')}</div>
      <div class="dw-legend"><span><i class="dw-a"></i>${esc(la)}</span><span><i class="dw-b"></i>${esc(lb)}</span>${rows.some((r) => r.projected) ? '<span><i class="dw-p"></i>Proyectado</span>' : ''}</div>`;
  }
  const meter = (used, total) => {
    if (!total) return '<span class="text-body-secondary">—</span>';
    const p = Math.round((used / total) * 100);
    return `<div class="d-flex align-items-center gap-2"><div class="progress flex-grow-1" style="height:7px"><div class="progress-bar ${p > 100 ? 'bg-danger' : p >= 80 ? 'bg-warning' : ''}" style="width:${Math.min(100, p)}%"></div></div><span class="small text-body-secondary">${p}%</span></div>`;
  };
  const kpis = (el, tiles) => { el.innerHTML = tiles.map(([l, v, sub, icon]) => `<div class="dw-card dw-kpi">${icon ? `<span class="dw-kpi__icon"><i class="bi ${esc(icon)}"></i></span>` : ''}<span><span class="dw-kpi__v d-block">${v}</span><span class="dw-kpi__l d-block">${esc(l)}</span>${sub ? `<span class="dw-kpi__d d-block">${sub}</span>` : ''}</span></div>`).join(''); };
  const rank = (el, rows, fmt = num) => {
    const max = Math.max(1, ...rows.map((r) => r.n));
    el.innerHTML = rows.length ? rows.map((r) => `<div class="dw-rank"><div class="d-flex small"><span class="flex-grow-1 text-truncate">${esc(r.k)}</span><b>${esc(fmt(r.n))}</b></div><div class="progress" style="height:5px"><div class="progress-bar" style="width:${(r.n / max * 100).toFixed(1)}%"></div></div></div>`).join('')
      : '<p class="text-body-secondary mb-0 small">Sin datos todavía.</p>';
  };
  // Secciones de arriba de una página: botones pequeños solo con palabras
  const seg = (el, items, onPick, initial) => {
    el.className = 'dw-segb'; el.hidden = false;
    el.innerHTML = items.map(([k, l]) => `<button type="button" class="btn btn-sm btn-outline-secondary ${k === initial ? 'active' : ''}" data-k="${k}">${esc(l)}</button>`).join('');
    el.onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; el.querySelectorAll('.btn').forEach((x) => x.classList.toggle('active', x === b)); onPick(b.dataset.k); };
  };
  // Descarga de un archivo generado (CSV) sin abrir otra pestaña
  async function download(path, fallback) {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('No se pudo descargar');
    const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || fallback;
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click();
  }

  window.App.Crud = { money, num, pct, day, monthName, todayCo, chip, refs, dropRefs, refName, form, table, bars, meter, kpis, rank, seg, download };
})();

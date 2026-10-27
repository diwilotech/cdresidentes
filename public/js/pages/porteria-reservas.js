// Pestaña «Reservas» de Portería: calendario de mes y de semana con reservas de varios días.
//   · Color de relleno = estado (por aprobar, aprobada, rechazada); franja lateral = zona (o tipo de solicitud).
//   · Se crea arrastrando sobre los días (mes) o tocando una hora (semana); también aparecen las solicitudes de portería con fecha.
window.PorteriaReservas = function mount(ctx) {
  const { esc, money, unitLabel } = App;
  const $ = (id) => document.getElementById(id);
  const ST = { pending: ['Por aprobar', 'warning'], approved: ['Aprobada', 'success'], rejected: ['Rechazada', 'danger'], cancelled: ['Cancelada', 'secondary'], done: ['Completada', 'primary'] };
  const UNIT = { evento: 'evento', hora: 'hora', dia: 'día' };
  const PAL = ['#0f766e', '#7c3aed', '#db2777', '#2563eb', '#ea580c', '#65a30d', '#0891b2', '#b45309'];
  const KCOL = { mudanza: '#ea580c', visita: '#2563eb', mantenimiento: '#65a30d', domicilio: '#0891b2', alarma: '#dc2626', otro: '#64748b' };
  const KNAME = { mudanza: 'Mudanza', visita: 'Visita', mantenimiento: 'Mantenimiento', domicilio: 'Domicilio', alarma: 'Alarma', otro: 'Otro' };
  const DOW = ['LU', 'MA', 'MI', 'JU', 'VI', 'SA', 'DO'];
  const HR = 44; // alto de una hora en la vista de semana (px)
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } } };

  const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const diff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
  const monday = (iso) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
  const mins = (h) => +h.slice(0, 2) * 60 + +h.slice(3);
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  let view = store.get('cdr_res_view') === 'week' ? 'week' : 'month';
  let anchor = App.todayLocal();
  let amenities = []; let bookings = []; let requests = []; let events = [];
  const hidden = new Set();            // zonas ocultas
  let showReq = store.get('cdr_res_req') !== '0';

  const color = (id) => PAL[Math.max(0, amenities.findIndex((a) => a.id === id)) % PAL.length];

  // ---------- zonas ----------
  async function loadAmenities() {
    amenities = (await App.api('/amenities' + App.qs())).items;
    $('amenities').innerHTML = amenities.length ? amenities.map((a) => `
      <div class="list-group-item d-flex align-items-center gap-2 ${a.active ? '' : 'opacity-50'}">
        <button class="zdot ${hidden.has(a.id) ? 'off' : ''}" style="--c:${color(a.id)}" data-zone="${esc(a.id)}" title="Mostrar u ocultar en el calendario"></button>
        <div class="flex-grow-1 min-w-0"><div class="fw-semibold text-truncate">${esc(a.name)}</div>
          <div class="small text-body-secondary">${App.currentProperty() ? '' : esc(a.property_name) + ' · '}${a.capacity ? `${a.capacity} personas · ` : ''}${money(a.fee)}/${UNIT[a.fee_unit]}</div></div>
        ${App.canManage() ? `<button class="btn btn-sm btn-outline-secondary" data-amenity="${esc(a.id)}"><i class="bi bi-pencil"></i></button>` : ''}
      </div>`).join('') : '<div class="empty small">Aún no hay zonas comunes. Crea la primera para recibir reservas.</div>';
  }

  // ---------- rango visible ----------
  function range() {
    if (view === 'week') { const s = monday(anchor); return [s, addDays(s, 6)]; }
    const first = `${anchor.slice(0, 7)}-01`; const s = monday(first);
    const last = `${anchor.slice(0, 7)}-${String(new Date(Date.UTC(+anchor.slice(0, 4), +anchor.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`;
    return [s, addDays(monday(last), 6)];
  }

  async function load() {
    const [from, to] = range();
    try {
      const [b, r] = await Promise.all([App.api('/bookings' + App.qs({ from, to })), showReq ? App.api('/requests' + App.qs()) : { items: [] }]);
      bookings = b.items; requests = r.items.filter((x) => x.scheduled_at && x.scheduled_at.slice(0, 10) >= from && x.scheduled_at.slice(0, 10) <= to);
    } catch (err) { return App.fail(err); }
    events = [
      ...bookings.filter((b) => b.status !== 'cancelled' && !hidden.has(b.amenity_id)).map((b) => ({
        t: 'b', id: b.id, title: b.amenity_name, who: b.holder || (b.number ? unitLabel(b) : ''), start: b.date, end: b.end_date || b.date,
        t0: b.start_time, t1: b.end_time, st: b.status, c: color(b.amenity_id), raw: b })),
      ...requests.map((q) => ({
        t: 'r', id: q.id, title: q.title, who: KNAME[q.kind] || '', start: q.scheduled_at.slice(0, 10), end: q.scheduled_at.slice(0, 10),
        t0: q.scheduled_at.slice(11, 16) || '08:00', t1: hhmm(Math.min(1439, mins(q.scheduled_at.slice(11, 16) || '08:00') + 60)), st: q.status, c: KCOL[q.kind] || KCOL.otro, raw: q })),
    ];
    paint();
    renderPending();
    renderList();
  }

  const label = () => {
    if (view === 'month') { const [y, m] = anchor.split('-').map(Number); return `${App.MESES_LARGOS[m - 1]} ${y}`; }
    const [s, e] = range(); const f = (i) => `${+i.slice(8)} ${['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][+i.slice(5, 7) - 1]}`;
    return `${f(s)} – ${f(e)} ${e.slice(0, 4)}`;
  };
  const evHtml = (e, cls, style) => `<div class="ev st-${e.st} ${cls}" style="--c:${e.c};${style}" data-ev="${e.t}:${esc(e.id)}" title="${esc(e.title)} · ${ST[e.st][0]}${e.t === 'b' ? ` · ${e.t0}–${e.t1}` : ''}">${
    e.t === 'r' ? '<i class="bi bi-door-open me-1"></i>' : ''}${e.start === e.end ? `<b>${e.t0}</b> ` : ''}${esc(e.title)}${e.who && e.t === 'b' ? `<span class="who"> · ${esc(e.who)}</span>` : ''}</div>`;

  function paint() {
    $('rangeLabel').textContent = label();
    document.querySelectorAll('#viewSw [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $('cal').innerHTML = view === 'month' ? monthHtml() : weekHtml();
    if (view === 'week') $('cal').querySelector('.wv-body').scrollTop = Math.max(0, 7 * HR - 6);
  }

  // ---------- vista de mes ----------
  function monthHtml() {
    const [from] = range(); const today = App.todayLocal(); const month = anchor.slice(0, 7);
    let html = `<div class="mv-dow">${DOW.map((d) => `<div>${d}</div>`).join('')}</div>`;
    for (let w = 0; w < 6; w++) {
      const days = Array.from({ length: 7 }, (_, i) => addDays(from, w * 7 + i));
      if (w >= 4 && days[0].slice(0, 7) !== month) break;
      const segs = events.filter((e) => e.start <= days[6] && e.end >= days[0]).map((e) => ({ e, s: Math.max(0, diff(days[0], e.start)), t: Math.min(6, diff(days[0], e.end)) }))
        .sort((a, b) => a.s - b.s || (b.t - b.s) - (a.t - a.s) || a.e.t0.localeCompare(b.e.t0));
      const lanes = []; const MAX = 3; const more = Array(7).fill(0);
      for (const sg of segs) {
        let l = lanes.findIndex((end) => end < sg.s);
        if (l < 0) { l = lanes.length; lanes.push(-1); }
        lanes[l] = sg.t; sg.l = l;
        if (l >= MAX) for (let i = sg.s; i <= sg.t; i++) more[i]++;
      }
      const rows = Math.min(MAX, lanes.length) + (more.some(Boolean) ? 1 : 0);
      html += `<div class="mv-wk"><div class="mv-bg" style="--rows:${rows}">${days.map((d) => `<div class="day ${d.slice(0, 7) === month ? '' : 'out'} ${d === today ? 'today' : ''}" data-day="${d}"><span class="n">${+d.slice(8)}</span></div>`).join('')}</div>
        <div class="mv-ev">${segs.filter((sg) => sg.l < MAX).map((sg) => evHtml(sg.e, `${sg.e.start < days[0] ? 'cs' : ''} ${sg.e.end > days[6] ? 'ce' : ''}`, `grid-column:${sg.s + 1}/span ${sg.t - sg.s + 1};grid-row:${sg.l + 1}`)).join('')}
        ${more.map((n, i) => (n ? `<div class="more" style="grid-column:${i + 1};grid-row:${MAX + 1}" data-day="${days[i]}">+${n} más</div>` : '')).join('')}</div></div>`;
    }
    return `<div class="mv">${html}</div>`;
  }

  // ---------- vista de semana ----------
  function weekHtml() {
    const [from] = range(); const today = App.todayLocal();
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const multi = events.filter((e) => e.start !== e.end);
    const lanes = []; const segs = multi.map((e) => ({ e, s: Math.max(0, diff(days[0], e.start)), t: Math.min(6, diff(days[0], e.end)) })).filter((x) => x.s <= 6 && x.t >= 0).sort((a, b) => a.s - b.s);
    for (const sg of segs) { let l = lanes.findIndex((end) => end < sg.s); if (l < 0) { l = lanes.length; lanes.push(-1); } lanes[l] = sg.t; sg.l = l; }
    const head = days.map((d, i) => `<div class="dh ${d === today ? 'today' : ''}" data-day="${d}"><span>${DOW[i]}</span><b>${+d.slice(8)}</b></div>`).join('');
    const allday = `<div class="wv-all" style="--rows:${Math.max(1, lanes.length)}"><div class="gut small">varios días</div><div class="wv-allgrid">${days.map((d) => `<div class="cell" data-day="${d}"></div>`).join('')}
      ${segs.map((sg) => evHtml(sg.e, `${sg.e.start < days[0] ? 'cs' : ''} ${sg.e.end > days[6] ? 'ce' : ''}`, `grid-column:${sg.s + 1}/span ${sg.t - sg.s + 1};grid-row:${sg.l + 1}`)).join('')}</div></div>`;
    const cols = days.map((d) => {
      const list = events.filter((e) => e.start === e.end && e.start === d).sort((a, b) => a.t0.localeCompare(b.t0));
      // columnas lado a lado para los que se cruzan
      const placed = []; let group = []; let gEnd = -1;
      const flush = () => { const n = Math.max(1, ...group.map((g) => g.l + 1)); group.forEach((g) => { g.n = n; }); placed.push(...group); group = []; };
      for (const e of list) {
        const s = mins(e.t0); const en = Math.max(s + 30, mins(e.t1));
        if (s >= gEnd && group.length) { flush(); gEnd = -1; }
        const used = group.filter((g) => g.en > s).map((g) => g.l);
        let l = 0; while (used.includes(l)) l++;
        group.push({ e, s, en, l }); gEnd = Math.max(gEnd, en);
      }
      if (group.length) flush();
      return `<div class="col ${d === today ? 'today' : ''}" data-day="${d}">${placed.map((p) => evHtml(p.e, 'tev', `top:${(p.s / 60) * HR}px;height:${Math.max(22, ((p.en - p.s) / 60) * HR - 2)}px;left:${(p.l / p.n) * 100}%;width:calc(${100 / p.n}% - 2px)`)).join('')}</div>`;
    }).join('');
    const hours = Array.from({ length: 24 }, (_, h) => `<div class="hr" style="height:${HR}px">${h ? `${String(h).padStart(2, '0')}:00` : ''}</div>`).join('');
    return `<div class="wv"><div class="wv-head"><div class="gut"></div>${head}</div>${allday}
      <div class="wv-body"><div class="gut">${hours}</div><div class="cols" style="--hr:${HR}px;height:${24 * HR}px">${cols}</div></div></div>`;
  }

  // ---------- pendientes y listado ----------
  function renderPending() {
    const pend = bookings.filter((b) => b.status === 'pending');
    $('pending').innerHTML = pend.length ? pend.map((b) => `<div class="list-group-item" style="border-left:4px solid ${color(b.amenity_id)}">
      <div class="d-flex justify-content-between gap-2"><div class="min-w-0"><div class="fw-semibold text-truncate">${esc(b.amenity_name)}</div>
        <div class="small text-body-secondary">${App.fmtDate(b.date)}${b.end_date && b.end_date !== b.date ? ' → ' + App.fmtDate(b.end_date) : ''} · ${esc(b.start_time)}–${esc(b.end_time)}${b.holder || b.number ? ' · ' + esc(b.holder || unitLabel(b)) : ''}</div></div>
        <div class="text-nowrap"><button class="btn btn-sm btn-outline-success" data-set="approved" data-id="${esc(b.id)}" title="Aprobar"><i class="bi bi-check2"></i></button>
        <button class="btn btn-sm btn-outline-danger" data-set="rejected" data-id="${esc(b.id)}" title="Rechazar"><i class="bi bi-x"></i></button></div></div></div>`).join('')
      : '<div class="empty small">Nada por aprobar en este periodo.</div>';
  }

  const COLS = [
    { title: 'Zona', value: (b) => b.amenity_name, html: (b) => `<span class="fw-semibold">${esc(b.amenity_name)}</span>` },
    { title: 'Fecha', value: (b) => b.date + (b.end_date && b.end_date !== b.date ? ' a ' + b.end_date : ''), html: (b) => `<span class="text-nowrap">${App.fmtDate(b.date, { weekday: true })}${b.end_date && b.end_date !== b.date ? ' → ' + App.fmtDate(b.end_date, { weekday: true }) : ''}</span>` },
    { title: 'Horario', value: (b) => `${b.start_time}-${b.end_time}` },
    { title: 'Unidad', value: (b) => (b.number ? unitLabel(b) : ''), html: (b) => (b.number ? esc(unitLabel(b)) : '—') },
    { title: 'Responsable', value: (b) => b.holder || b.owner_name || '' },
    { title: 'Valor', sum: true, value: (b) => b.amount || 0, html: (b) => money(b.amount) },
    { title: 'Pago', value: (b) => (b.paid ? 'Pagada' : 'Sin pagar'), html: (b) => (b.paid ? '<i class="bi bi-check-circle-fill text-success"></i> Pagada' : '<span class="text-danger">Sin pagar</span>') },
    { title: 'Estado', value: (b) => ST[b.status][0], html: (b) => App.badge(ST[b.status][0], ST[b.status][1]) },
    { title: 'Acciones', noExport: true, orderable: false, className: 'text-end text-nowrap',
      html: (b) => `<button class="btn btn-sm btn-outline-secondary" data-edit="${esc(b.id)}" title="Editar"><i class="bi bi-pencil"></i></button>` },
  ];
  async function renderList() {
    $('count').textContent = `(${bookings.length})`;
    await App.dataTable($('bookList'), { columns: COLS, data: bookings, order: [[1, 'asc']], title: 'Reservas' });
  }

  // ---------- formularios ----------
  function editAmenity(a) {
    if (!App.properties.length) return App.toast('Primero crea un conjunto', 'warning');
    const { el } = App.formDialog({
      title: a ? 'Editar zona común' : 'Nueva zona común',
      data: a || { property_id: App.currentProperty() || App.properties[0].id, fee_unit: 'evento', active: 1, fee: 0 },
      extraFooter: a ? '<button type="button" class="btn btn-outline-danger me-auto" data-del><i class="bi bi-trash"></i></button>' : '',
      fields: `
        <div class="row g-2">
          <div class="col-12"><label class="form-label small">Conjunto</label><select name="property_id" class="form-select">${App.propertyOptions()}</select></div>
          <div class="col-12"><label class="form-label small">Nombre *</label><input name="name" class="form-control" required maxlength="120" placeholder="Salón social A"></div>
          <div class="col-6"><label class="form-label small">Tarifa (COP)</label><input name="fee" type="number" min="0" step="1000" class="form-control"></div>
          <div class="col-6"><label class="form-label small">Por</label><select name="fee_unit" class="form-select"><option value="evento">Evento</option><option value="hora">Hora</option><option value="dia">Día</option></select></div>
          <div class="col-6"><label class="form-label small">Capacidad</label><input name="capacity" type="number" min="0" class="form-control"></div>
          <div class="col-6 d-flex align-items-end"><div class="form-check"><input class="form-check-input" type="checkbox" name="active" id="act"><label class="form-check-label" for="act">Disponible</label></div></div>
          <div class="col-12"><label class="form-label small">Reglamento de uso</label><textarea name="rules" class="form-control" rows="3" maxlength="2000"></textarea></div>
        </div>`,
      onSave: async (d) => {
        if (a) await App.api(`/amenities/${a.id}`, { method: 'PUT', body: d });
        else await App.api('/amenities', { method: 'POST', body: d });
        App.toast('Zona guardada'); await loadAmenities(); load();
      },
    });
    el.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await App.confirmAction('¿Eliminar esta zona y sus reservas?'))) return;
      try { await App.api(`/amenities/${a.id}`, { method: 'DELETE' }); bootstrap.Modal.getInstance(el).hide(); await loadAmenities(); load(); } catch (err) { App.fail(err); }
    });
  }

  function editBooking(b, pre = {}) {
    const active = amenities.filter((a) => a.active);
    if (!active.length) return App.toast('Primero crea una zona común', 'warning');
    const first = b ? amenities.find((a) => a.id === b.amenity_id) : active[0];
    const quick = b && b.status === 'pending' ? `<button type="button" class="btn btn-success" data-quick="approved"><i class="bi bi-check2 me-1"></i>Aprobar</button><button type="button" class="btn btn-outline-danger" data-quick="rejected"><i class="bi bi-x-lg me-1"></i>Rechazar</button>` : '';
    const { el, form } = App.formDialog({
      title: b ? 'Editar reserva' : 'Nueva reserva',
      data: b ? { ...b, end_date: b.end_date || '', property_id: first?.property_id }
        : { amenity_id: first.id, property_id: first.property_id, date: App.todayLocal(), end_date: '', start_time: '14:00', end_time: '18:00', status: 'approved', ...pre },
      extraFooter: `${b ? '<button type="button" class="btn btn-outline-danger me-auto" data-del><i class="bi bi-trash"></i></button>' : ''}${quick}`,
      fields: `
        <div class="row g-2">
          <div class="col-12"><label class="form-label small">Zona</label><select name="amenity_id" class="form-select">${amenities.map((a) => `<option value="${esc(a.id)}" data-prop="${esc(a.property_id)}">${esc(a.name)} · ${money(a.fee)}/${UNIT[a.fee_unit]}${App.currentProperty() ? '' : ' · ' + esc(a.property_name)}</option>`).join('')}</select></div>
          <input type="hidden" name="property_id">
          <div class="col-12"><label class="form-label small">Unidad</label><select name="unit_id" class="form-select"></select></div>
          <div class="col-6"><label class="form-label small">Desde (día)</label><input name="date" type="date" class="form-control" required></div>
          <div class="col-6"><label class="form-label small">Hasta (varios días)</label><input name="end_date" type="date" class="form-control"></div>
          <div class="col-6"><label class="form-label small">Hora de inicio</label><input name="start_time" type="time" class="form-control" required></div>
          <div class="col-6"><label class="form-label small">Hora de fin</label><input name="end_time" type="time" class="form-control" required></div>
          <div class="col-sm-6"><label class="form-label small">Responsable</label><input name="holder" class="form-control" maxlength="120"></div>
          <div class="col-sm-6"><label class="form-label small">Valor (vacío = tarifa)</label><input name="amount" type="number" min="0" class="form-control"></div>
          <div class="col-sm-6"><label class="form-label small">Estado</label><select name="status" class="form-select">${Object.entries(ST).filter(([k]) => k !== 'done').map(([k, [v]]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="col-sm-6 d-flex align-items-end"><div class="form-check"><input class="form-check-input" type="checkbox" name="paid" id="paid"><label class="form-check-label" for="paid">Pagada</label></div></div>
          <div class="col-12"><label class="form-label small">Notas</label><input name="notes" class="form-control" maxlength="1000"></div>
        </div>`,
      onSave: async (d) => {
        delete d.property_id;
        d.end_date = d.end_date && d.end_date !== d.date ? d.end_date : '';
        if (b) await App.api(`/bookings/${b.id}`, { method: 'PUT', body: d });
        else await App.api('/bookings', { method: 'POST', body: d });
        App.toast('Reserva guardada'); load();
      },
    });
    const syncProp = () => { form.elements.property_id.value = form.elements.amenity_id.selectedOptions[0].dataset.prop; form.elements.property_id.dispatchEvent(new Event('change')); };
    form.elements.amenity_id.addEventListener('change', syncProp);
    App.bindUnitSelect(form, { selected: b?.unit_id || '' });
    el.querySelectorAll('[data-quick]').forEach((q) => q.addEventListener('click', async () => {
      try { await App.api(`/bookings/${b.id}`, { method: 'PUT', body: { status: q.dataset.quick } }); bootstrap.Modal.getInstance(el).hide(); App.toast(ST[q.dataset.quick][0]); load(); } catch (err) { App.fail(err); }
    }));
    el.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await App.confirmAction('¿Eliminar esta reserva?'))) return;
      try { await App.api(`/bookings/${b.id}`, { method: 'DELETE' }); bootstrap.Modal.getInstance(el).hide(); load(); } catch (err) { App.fail(err); }
    });
  }

  // ---------- interacción ----------
  const shift = (n) => { anchor = view === 'week' ? addDays(anchor, 7 * n) : (() => { const d = new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); })(); load(); };
  $('prev').addEventListener('click', () => shift(-1));
  $('next').addEventListener('click', () => shift(1));
  $('today').addEventListener('click', () => { anchor = App.todayLocal(); load(); });
  $('viewSw').addEventListener('click', (ev) => { const b = ev.target.closest('[data-view]'); if (!b) return; view = b.dataset.view; store.set('cdr_res_view', view); load(); });
  $('showReq').checked = showReq;
  $('showReq').addEventListener('change', () => { showReq = $('showReq').checked; store.set('cdr_res_req', showReq ? '1' : '0'); load(); });
  $('newBook').addEventListener('click', () => editBooking(null, { date: anchor }));
  $('newAmenity').addEventListener('click', () => editAmenity(null));
  $('amenities').addEventListener('click', (ev) => {
    const z = ev.target.closest('[data-zone]');
    if (z) { hidden.has(z.dataset.zone) ? hidden.delete(z.dataset.zone) : hidden.add(z.dataset.zone); z.classList.toggle('off'); return load(); }
    const b = ev.target.closest('[data-amenity]'); if (b) editAmenity(amenities.find((a) => a.id === b.dataset.amenity));
  });
  $('pending').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-set]'); if (!b) return;
    try { await App.api(`/bookings/${b.dataset.id}`, { method: 'PUT', body: { status: b.dataset.set } }); App.toast(ST[b.dataset.set][0]); load(); } catch (err) { App.fail(err); }
  });
  $('bookList').addEventListener('click', (ev) => { const b = ev.target.closest('[data-edit]'); if (b) editBooking(bookings.find((x) => x.id === b.dataset.edit)); });

  const openEvent = (key) => {
    const [t, id] = [key.slice(0, 1), key.slice(2)];
    if (t === 'b') return editBooking(bookings.find((x) => x.id === id));
    ctx.editRequest(requests.find((x) => x.id === id));
  };
  // Arrastrar sobre los días (mes) para reservar varios días de una vez.
  let drag = null;
  const mark = () => { if (!drag) return; const [a, b] = [drag.a, drag.b].sort(); $('cal').querySelectorAll('.day[data-day]').forEach((d) => d.classList.toggle('sel', d.dataset.day >= a && d.dataset.day <= b)); };
  $('cal').addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('[data-ev]')) return;
    const d = ev.target.closest('.mv .day[data-day]'); if (d) { drag = { a: d.dataset.day, b: d.dataset.day }; mark(); ev.preventDefault(); }
  });
  $('cal').addEventListener('mouseover', (ev) => { const d = drag && ev.target.closest('.day[data-day]'); if (d) { drag.b = d.dataset.day; mark(); } });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    const [a, b] = [drag.a, drag.b].sort(); drag = null; mark();
    editBooking(null, { date: a, end_date: b > a ? b : '' });
  });
  $('cal').addEventListener('click', (ev) => {
    const e = ev.target.closest('[data-ev]'); if (e) return openEvent(e.dataset.ev);
    const more = ev.target.closest('.more'); if (more) { anchor = more.dataset.day; view = 'week'; return load(); }
    const col = ev.target.closest('.wv .col');
    if (col) {
      const m = Math.min(22 * 60, Math.floor(((ev.clientY - col.getBoundingClientRect().top) / HR) * 2) * 30);
      return editBooking(null, { date: col.dataset.day, start_time: hhmm(m), end_time: hhmm(Math.min(1439, m + 120)) });
    }
    const dh = ev.target.closest('.wv .dh, .wv .cell'); if (dh) editBooking(null, { date: dh.dataset.day });
  });

  App.onProperty(() => { loadAmenities().then(load).catch(App.fail); });
  loadAmenities().then(load).catch(App.fail);
};

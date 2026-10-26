// Inicio = el módulo Dashboard de Diwilo Modulos (saludo con la marca, alertas, resúmenes de los módulos centrales, accesos directos).
// Aquí solo se registra lo PROPIO de Residentes:
//   · el ámbito «Conjunto» (window.DwDashboardAmbito): sin conjunto elegido el Inicio es el portafolio (una tarjeta por conjunto);
//     con uno elegido muestra sus estadísticas, y el selector de la barra superior sigue en sincronía.
//   · los indicadores del conjunto (window.DwDashboard): cartera, PQRS, portería, reservas, comunicados y ocupación.
(() => {
  const App = window.Res;   // ayudas de Residentes (conjuntos, formatos); window.App es el común del Dashboard
  const ready = App.init('inicio');   // lista de conjuntos y conjunto activo (la página no se detiene si falta elegir uno)
  const { esc, money, moneyShort, unitLabel } = App;
  const kpi = (label, value, icon, cls = '', sub = '') => `
    <div class="col-6 col-md-4 col-xl-2"><div class="card kpi"><div class="d-flex justify-content-between gap-2">
      <div class="min-w-0"><div class="kpi-label">${label}</div><div class="kpi-value text-truncate">${value}</div>${sub ? `<div class="small text-body-secondary">${sub}</div>` : ''}</div>
      <div class="kpi-icon ${cls}"><i class="bi ${icon}"></i></div></div></div></div>`;
  const empty = (t) => `<div class="empty small">${esc(t)}</div>`;

  // El selector de conjunto de la barra superior cambió: el Inicio se vuelve a pintar con el conjunto elegido (o con el portafolio)
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent || e.data?.dw !== 'sede') return;
    setTimeout(() => document.querySelector('[data-refrescar]')?.click(), 120);
  });

  // ---- ámbito: los conjuntos ----
  window.DwDashboardAmbito = {
    etiqueta: 'Conjunto', plural: 'Conjuntos',
    async items() {
      await ready;
      const { items } = await App.api('/properties');
      App.properties = items;
      return items.filter((p) => p.status === 'active').map((p) => ({
        id: p.id, nombre: p.name, detalle: [p.address, p.city].filter(Boolean).join(' · ') || 'Sin dirección',
        kpis: [{ valor: App.fmtNum(p.units, 0), titulo: 'Unidades' }, { valor: moneyShort(p.overdue), titulo: 'Cartera vencida' }, { valor: p.open_pqrs, titulo: 'PQRS abiertas' }],
      }));
    },
    actual: () => App.currentProperty(),
    elegir: (id) => { App.setProperty(id || ''); App.refreshPropertySelects(); },
  };

  // ---- indicadores del conjunto activo ----
  (window.DwDashboard = window.DwDashboard || []).push({
    id: 'conjunto',
    titulo: 'Tu conjunto',
    async mount(host) {
      await ready;
      const pid = App.currentProperty();
      host.innerHTML = '<div class="empty small">Cargando…</div>';
      const [d, { items: all }] = await Promise.all([App.api('/dashboard' + App.qs()), App.api('/properties')]);
      App.properties = all;
      const moraPct = d.units ? Math.round((d.cartera.debtors / d.units) * 100) : 0;
      const p = all.find((x) => x.id === pid);
      const REQ_ICON = { mudanza: 'bi-truck', visita: 'bi-person-badge', mantenimiento: 'bi-tools', domicilio: 'bi-box-seam', alarma: 'bi-bell', otro: 'bi-three-dots' };
      const occ = d.occupancy, tot = (occ.owner || 0) + (occ.tenant || 0) + (occ.vacant || 0) || 1;
      const bar = (k, label, cls) => { const pct = Math.round(((occ[k] || 0) / tot) * 100); return `<div class="mb-2"><div class="d-flex justify-content-between small"><span>${label}</span><span class="mono">${occ[k] || 0} · ${pct}%</span></div><div class="progress" style="height:8px"><div class="progress-bar ${cls}" style="width:${pct}%"></div></div></div>`; };
      host.innerHTML = `
        <div class="row g-3 mb-3">${[
          kpi('Total unidades', App.fmtNum(d.units, 0), 'bi-house-door'),
          kpi('Censo habitantes', App.fmtNum(d.residents, 0), 'bi-people'),
          kpi('Cartera vencida', moneyShort(d.cartera.overdue), 'bi-cash-coin', 'red', `${d.cartera.debtors} unidades`),
          kpi('En mora', `${moraPct}%`, 'bi-graph-down-arrow', moraPct > 10 ? 'red' : 'amber'),
          kpi('PQRS abiertas', d.pqrs.open, 'bi-chat-square-text', d.pqrs.urgent ? 'red' : 'amber', d.pqrs.urgent ? `${d.pqrs.urgent} urgentes` : ''),
          kpi('Visitas hoy', d.requests.visitsToday, 'bi-person-badge', 'violet', `${d.requests.pending} solicitudes pend.`),
        ].join('')}</div>
        <div class="row g-3">
          <div class="col-xl-8">
            <div class="card mb-3"><div class="card-header"><i class="bi bi-buildings me-2 text-primary"></i>Conjunto</div>
              <div class="card-body">${p ? `<div class="fw-bold">${esc(p.name)}</div>
                <div class="small text-body-secondary">${esc([p.nit && `NIT ${p.nit}`, p.address, p.city].filter(Boolean).join(' · ') || 'Sin dirección')}</div>
                ${p.towers ? `<div class="small text-body-secondary">${esc(p.towers)}</div>` : ''}` : ''}
                ${d.cartera.debtors ? `<p class="mt-3 mb-0 small">Hay <strong>${d.cartera.debtors} unidades en mora</strong> (${moraPct}% del total) que suman <strong>${money(d.cartera.overdue)}</strong>${d.debtors[0] ? `; la deuda más alta es <strong>${esc(unitLabel(d.debtors[0]))}</strong> con ${money(d.debtors[0].overdue)}` : ''}. Este mes se ha recaudado ${money(d.cartera.collected_month)}.</p>` : ''}</div></div>
            <div class="card"><div class="card-header d-flex justify-content-between align-items-center"><span><i class="bi bi-exclamation-octagon me-2 text-danger"></i>Atrasos más altos</span><a href="/staff/cartera.html" class="small">Ir a cartera</a></div>
              <div class="list-group list-group-flush" data-debtors>${d.debtors.length ? d.debtors.map((u) => `
                <div class="list-group-item d-flex align-items-center gap-3">
                  <span class="avatar">${esc(App.initials(u.owner_name))}</span>
                  <div class="flex-grow-1 min-w-0"><div class="fw-semibold text-truncate">${esc(unitLabel(u))}</div>
                    <div class="small text-body-secondary text-truncate">${esc(u.owner_name || 'Sin propietario')} · atraso ${App.daysSince(u.oldest_due)} días</div></div>
                  <div class="text-end"><div class="fw-bold mono text-danger">${money(u.overdue)}</div>
                    <button class="btn btn-sm btn-ai mt-1" data-cobrar="${esc(u.id)}"><i class="bi bi-stars me-1"></i>Cobrar</button></div>
                </div>`).join('') : empty('Sin unidades en mora. ¡Cartera al día!')}</div></div>
          </div>
          <div class="col-xl-4">
            <div class="card mb-3"><div class="card-header"><i class="bi bi-pie-chart me-2 text-primary"></i>Distribución habitacional</div>
              <div class="card-body">${bar('owner', 'Propietarios residentes', 'bg-success')}${bar('tenant', 'Arrendatarios', 'bg-info')}${bar('vacant', 'Desocupadas', 'bg-secondary')}
                <div class="small text-body-secondary mt-2"><i class="bi bi-heart me-1"></i>${d.pets} mascotas registradas</div></div></div>
            <div class="card mb-3"><div class="card-header d-flex justify-content-between"><span><i class="bi bi-door-open me-2 text-primary"></i>Portería pendiente</span><a href="/staff/porteria.html" class="small">Ver</a></div>
              <div class="list-group list-group-flush">${d.pending.length ? d.pending.map((r) => `
                <a class="list-group-item list-group-item-action small" href="/staff/porteria.html"><i class="bi ${REQ_ICON[r.kind] || 'bi-dot'} me-2"></i>${esc(r.title)}
                  <span class="text-body-secondary">${r.number ? ' · ' + esc(unitLabel(r)) : ''}${r.scheduled_at ? ' · ' + App.fmtDateTime(r.scheduled_at) : ''}</span></a>`).join('') : empty('Nada pendiente')}</div></div>
            <div class="card mb-3"><div class="card-header d-flex justify-content-between"><span><i class="bi bi-calendar2-week me-2 text-primary"></i>Próximas reservas</span><a href="/staff/reservas.html" class="small">Ver</a></div>
              <div class="list-group list-group-flush">${d.bookings.length ? d.bookings.map((b) => `
                <div class="list-group-item small"><span class="fw-semibold">${esc(b.amenity)}</span> · ${App.fmtDate(b.date, { weekday: true })} ${esc(b.start_time)}–${esc(b.end_time)}
                  <span class="text-body-secondary">${b.number ? ' · ' + esc(unitLabel(b)) : b.holder ? ' · ' + esc(b.holder) : ''}</span>${b.status === 'pending' ? ' ' + App.badge('Por aprobar', 'warning') : ''}</div>`).join('') : empty('Sin reservas próximas')}</div></div>
            <div class="card"><div class="card-header d-flex justify-content-between"><span><i class="bi bi-megaphone me-2 text-primary"></i>Comunicados recientes</span><a href="/staff/comunicados.html" class="small">Ver todos</a></div>
              <div class="list-group list-group-flush">${d.notices.length ? d.notices.map((n) => `
                <a class="list-group-item list-group-item-action small" href="/staff/comunicados.html"><div class="fw-semibold">${esc(n.title)}</div>
                  <div class="text-body-secondary">${esc(n.category)} · ${App.fmtDate(n.created_at)}</div></a>`).join('') : empty('Sin comunicados')}</div></div>
          </div>
        </div>`;
      host.onclick = (ev) => {
        const c = ev.target.closest('[data-cobrar]');
        if (c) App.messageDialog(d.debtors.find((u) => u.id === c.dataset.cobrar), { aiCobro: true });
      };
    },
  });
})();

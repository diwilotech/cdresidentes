// Shell común de las apps Diwilo: barra superior, barra lateral (escritorio) y barra inferior con «Más» (celular).
// Lo pinta todo a partir de GET /api/me (módulos activos, rol y tema). Cada página solo trae:
//   <div id="dw-shell"></div>
//   <main class="dw-main" data-titulo="Elementos" data-modulo="items"> … </main>
// y espera a DW.ready (Promise con /api/me) para cargar sus datos.
(function () {
  const { api, esc, changePassword } = window.App;
  // Colores de la app (paleta cerrada): se cambian desde el menú de usuario; el logo y el resto de la marca, en Marca
  const ROLE = { owner: 'Propietario', admin: 'Administrador', staff: 'Personal' };
  const RANK = { staff: 1, admin: 2, owner: 3 };
  const main = document.querySelector('main.dw-main');
  const page = { titulo: main?.dataset.titulo || '', modulo: main?.dataset.modulo || '' };
  // Panel (/<dirección del negocio>): una sola página con el menú; cada módulo se carga en un marco y la dirección no cambia.
  // Páginas «incrustadas»: las de los módulos dentro de ese marco; no pintan menú ni barras, solo su contenido.
  const PANEL = document.body.hasAttribute('data-panel');
  const EMBED = window.top !== window.self;
  if (EMBED) document.body.classList.add('dw-embed');   // desde ya, para que no salte el diseño mientras carga
  const panel = { modulo: 'inicio', titulo: '' };
  const aInicio = () => (EMBED ? window.top : window).location.replace('/');

  // Módulos base (siempre activos) + los del negocio, en el orden del menú.
  const BASE_START = [{ id: 'inicio', nombre: 'Inicio', icono: 'bi-house', ruta: '/staff/' }];
  const BASE_END = [
    { id: 'equipo', nombre: 'Equipo', icono: 'bi-people', ruta: '/staff/equipo.html' },
  ];

  function applyTheme(s) {
    const root = document.documentElement;
    root.dataset.dwTema = s.tema;
    root.setAttribute('data-bs-theme', s.modo);
    try { localStorage.setItem('dw_tema', JSON.stringify({ tema: s.tema, modo: s.modo })); } catch (_) {}
    // Dentro del panel (marco), avisa al panel para que el encabezado y el menú cambien al mismo tiempo.
    if (EMBED) try { window.parent.postMessage({ dw: 'tema', tema: s.tema, modo: s.modo }, location.origin); } catch (_) {}
    const color = getComputedStyle(root).getPropertyValue('--dw-p').trim();
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = s.modo === 'dark' ? '#171a23' : color || '#6d28d9';
  }

  const isActive = (m) => {
    const here = location.pathname.replace(/index\.html$/, '');
    if (PANEL) return m.id === panel.modulo;
    return m.id === page.modulo || (m.ruta && m.ruta.replace(/index\.html$/, '') === here);
  };
  let inBottom = new Set();
  const link = (m) => `<li class="${inBottom.has(m.id) ? 'dw-in-bottom' : ''}"><a data-mod="${esc(m.id)}" href="${esc(m.ruta)}" class="${isActive(m) ? 'active' : ''}" ${isActive(m) ? 'aria-current="page"' : ''} title="${esc(m.nombre)}"><i class="bi ${esc(m.icono || 'bi-grid')}"></i><span>${esc(m.nombre)}</span></a></li>`;

  function render(me) {
    // «IA» va abajo, junto a Equipo; «Marca» tiene su propia pantalla en el menú (módulo central de Diwilo Modulos)
    const iaMod = me.modules.find((m) => m.id === 'ai');
    const FOOT = [...BASE_END, ...(iaMod ? [iaMod] : [])];
    const mods = [...BASE_START, ...me.modules.filter((m) => !m.oculto && m.id !== 'ai' && m.id !== 'dashboard').sort((a, b) => a.orden - b.orden), ...FOOT];
    const initials = (me.user.name || me.user.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    const logo = me.settings.logo ? `<img src="${esc(me.settings.logo)}" alt="">` : esc(me.business.name.trim()[0] || 'D').toUpperCase();
    const canManage = RANK[me.role] >= RANK.admin;
    // Celular: máximo 4 módulos en la barra inferior + «Más» (abre la barra lateral como offcanvas).
    const bottom = mods.slice(0, 4);
    // En «Más» solo va lo que no cabe abajo (si todo cabe, «Más» muestra el menú completo).
    inBottom = new Set(mods.length > 4 ? bottom.map((m) => m.id) : []);
    const moreActive = !bottom.some(isActive);

    if (!EMBED) document.getElementById('dw-shell').innerHTML = `
      <a class="visually-hidden-focusable position-absolute top-0 start-0 m-2 btn btn-primary" style="z-index:2000" href="#dw-content">Saltar al contenido</a>
      <header class="dw-top">
        <a class="dw-brand" data-mod="inicio" href="/staff/"><span class="dw-brand__logo">${logo}</span><span class="dw-brand__name d-none d-lg-inline">${esc(me.business.name)}</span></a>
        <span class="dw-top__sep d-none d-lg-inline">/</span>
        <span class="dw-top__title" data-top-title>${esc(page.titulo)}</span>
        <span class="dw-top__spacer"></span>
        ${me.ambito ? `<label class="dw-sede" data-sede-box title="${esc(me.ambito.etiqueta)} activo"><i class="bi bi-buildings"></i><select class="form-select form-select-sm" data-sede-select aria-label="${esc(me.ambito.etiqueta)} activo"><option value="">Cargando…</option></select></label>` : ''}
        <div class="dropdown">
          <button class="dw-iconbtn" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Notificaciones"><i class="bi bi-bell"></i><span class="dw-dot" data-bell-dot ${me.business.readOnly ? '' : 'hidden'}></span></button>
          <div class="dropdown-menu dropdown-menu-end p-0" style="width:300px"><div class="px-3 py-2 fw-semibold border-bottom">Notificaciones</div>
            ${me.business.readOnly ? `<div class="px-3 py-2 small"><i class="bi bi-lock-fill text-danger me-1"></i>La suscripción venció: la app quedó en solo lectura. Escríbele a Diwilo para reactivarla.</div>` : ''}<div data-notifs><div class="px-3 py-3 small text-body-secondary text-center">No tienes notificaciones.</div></div></div>
        </div>
        <div class="dropdown">
          <button class="dw-user" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Menú de usuario"><span class="dw-avatar">${esc(initials)}</span><i class="bi bi-chevron-down small d-none d-sm-inline"></i></button>
          <ul class="dropdown-menu dropdown-menu-end shadow-sm">
            <li class="px-3 py-2"><div class="fw-semibold">${esc(me.user.name || me.user.email)}</div><div class="small text-body-secondary">${esc(me.user.email)} · ${ROLE[me.role] || esc(me.role)}</div></li>
            <li><hr class="dropdown-divider"></li>
            ${me.businesses.length > 1 ? `<li><h6 class="dropdown-header">Cambiar de negocio</h6></li>${me.businesses.map((b) => `<li><button class="dropdown-item ${b.id === me.business.id ? 'active' : ''}" data-biz="${esc(b.id)}"><i class="bi bi-shop me-2"></i>${esc(b.name)}</button></li>`).join('')}<li><hr class="dropdown-divider"></li>` : ''}
            ${canManage && me.modules.some((m) => m.id === 'marca') ? `<li><a class="dropdown-item" data-mod="marca" href="/staff/marca.html"><i class="bi bi-palette me-2"></i>Color y marca</a></li>` : ''}
            <li><button class="dropdown-item" data-pass><i class="bi bi-key me-2"></i>Cambiar contraseña</button></li>
            <li><a class="dropdown-item" href="/privacidad" target="_blank" rel="noopener"><i class="bi bi-shield-check me-2"></i>Política de datos</a></li>
            <li><hr class="dropdown-divider"></li>
            <li><button class="dropdown-item text-danger" data-logout><i class="bi bi-box-arrow-right me-2"></i>Cerrar sesión</button></li>
          </ul>
        </div>
      </header>
      <aside class="offcanvas-lg offcanvas-start dw-side" tabindex="-1" id="dwSide" aria-label="Menú">
        <div class="offcanvas-header border-bottom"><span class="fw-bold">${esc(me.app.nombre)}</span><button type="button" class="btn-close" data-bs-dismiss="offcanvas" data-bs-target="#dwSide" aria-label="Cerrar"></button></div>
        <div class="offcanvas-body"><nav><ul class="dw-nav">${mods.slice(0, -FOOT.length).map(link).join('')}</ul></nav></div>
        <div class="dw-side__foot"><ul class="dw-nav dw-nav--foot">${FOOT.map(link).join('')}</ul><button class="dw-iconbtn w-100 dw-collapse" data-mini title="Contraer o expandir el menú" aria-label="Contraer o expandir el menú"><i class="bi bi-chevron-double-left"></i></button></div>
      </aside>
      <nav class="dw-bottom" aria-label="Menú principal">
        ${bottom.map((m) => `<a data-mod="${esc(m.id)}" href="${esc(m.ruta)}" class="${isActive(m) ? 'active' : ''}"><i class="bi ${esc(m.icono)}"></i><span>${esc(m.nombre)}</span></a>`).join('')}
        <button type="button" class="${moreActive ? 'active' : ''}" data-bs-toggle="offcanvas" data-bs-target="#dwSide" aria-controls="dwSide"><i class="bi bi-grid"></i><span>Más</span></button>
      </nav>`;
    if (main) main.id = 'dw-content';
    if (me.business.readOnly && main) main.insertAdjacentHTML('afterbegin', '<div class="dw-readonly"><i class="bi bi-lock-fill me-1"></i>Suscripción vencida: la app está en solo lectura. Escríbele a Diwilo para reactivarla.</div>');
    document.querySelectorAll('[data-write]').forEach((b) => (b.disabled = me.business.readOnly));
    document.title = `${page.titulo ? page.titulo + ' · ' : ''}${me.business.name} · ${me.app.nombre}`;

    if (!EMBED) {
      try { if (localStorage.getItem('dw_mini') === '1') document.body.classList.add('dw-mini'); } catch (_) {}
      document.querySelector('[data-mini]').onclick = () => {
        document.body.classList.toggle('dw-mini');
        try { localStorage.setItem('dw_mini', document.body.classList.contains('dw-mini') ? '1' : '0'); } catch (_) {}
      };
      document.querySelector('[data-pass]').onclick = changePassword;
      // El color y el modo ya no se eligen aquí: los maneja Marca → Color y letra (guarda para todo el equipo y este panel los toma por mensaje)
      document.querySelector('[data-logout]').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.replace('/'); };
      document.querySelectorAll('[data-biz]').forEach((b) => (b.onclick = async () => {
        await api('/api/auth/business', { method: 'POST', body: { businessId: b.dataset.biz } });
        location.replace('/');
      }));

    }

    // Página de un módulo inactivo o sin permiso: no se muestra su contenido.
    if (page.modulo && !['inicio', 'equipo'].includes(page.modulo) && !me.modules.some((m) => m.id === page.modulo) && main) {
      main.innerHTML = `<div class="dw-card">${window.App.empty('bi-slash-circle', 'Este módulo no está activo para tu negocio o tu rol no tiene acceso.', '<a class="btn btn-primary" href="/staff/">Ir al inicio</a>')}</div>`;
      if (EMBED) notificar();
      return false;
    }
    if (EMBED) { document.body.classList.add('dw-embed'); notificar(); }
    if (PANEL) { iniciarPanel(); iniciarAmbito(me, document.getElementById('dw-frame')); bienvenida(me); }
    return true;
  }

  // Una página incrustada le avisa al panel dónde está para marcar el menú y poner el título.
  function notificar() {
    document.body.classList.add('dw-embed');
    window.parent.postMessage({ dw: 'page', modulo: page.modulo || 'inicio', titulo: page.titulo, url: location.pathname + location.search + location.hash }, location.origin);
  }

  // Bienvenida con la marca (logo, nombre y lema): una vez por sesión, breve, se cierra sola o al tocarla
  async function bienvenida(me) {
    try { if (sessionStorage.getItem('dw_splash') === '1') return; sessionStorage.setItem('dw_splash', '1'); } catch (_) {}
    const el = document.createElement('div');
    el.id = 'dw-splash'; el.setAttribute('role', 'status'); el.setAttribute('aria-label', 'Bienvenida');
    el.innerHTML = `<div class="dw-splash__logo">${me.settings.logo ? `<img src="${esc(me.settings.logo)}" alt="">` : `<span>${esc((me.business.name.trim()[0] || 'D').toUpperCase())}</span>`}</div><div class="dw-splash__name">${esc(me.business.name)}</div><div class="dw-splash__lema" data-splash-lema></div>`;
    document.body.appendChild(el);
    const cerrar = () => { el.classList.add('out'); setTimeout(() => el.remove(), 450); };
    el.addEventListener('click', cerrar);
    const t0 = Date.now();
    const lema = await Promise.race([api('/api/marca').then((d) => d.marca?.lema || '').catch(() => ''), new Promise((r) => setTimeout(() => r(''), 900))]);
    const l = el.querySelector('[data-splash-lema]'); if (l) l.textContent = lema;
    setTimeout(cerrar, Math.max(500, 1200 - (Date.now() - t0)));
  }

  // Campana: avisos de las pantallas (alertas del Dashboard) además del aviso de suscripción vencida
  function setNotifs(list) {
    const box = document.querySelector('[data-notifs]'); if (!box) return;
    box.innerHTML = list.length ? list.map((n) => `<a class="dropdown-item d-flex gap-2 align-items-start py-2 text-wrap" ${n.ruta ? `data-go="${esc(n.ruta)}"` : ''} href="${esc(n.ruta || '#')}"><i class="bi ${esc(n.icono || 'bi-bell')} text-primary mt-1"></i><span class="small">${esc(n.texto)}</span></a>`).join('')
      : '<div class="px-3 py-3 small text-body-secondary text-center">No tienes notificaciones.</div>';
    const dot = document.querySelector('[data-bell-dot]'); if (dot) dot.hidden = !list.length && !DW.me?.business?.readOnly;
  }

  // Ámbito (sedes): conjuntos, edificios… El selector de la barra elige la sede con la que trabajan las páginas (se recuerda en el navegador).
  function iniciarAmbito(me, frame) {
    const amb = me.ambito, sel = document.querySelector('[data-sede-select]');
    if (!amb || !sel) return;
    const KEY = `${amb.clave || 'sede'}_${me.business.slug}`;
    let items = [];
    const guardada = () => { try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } };
    const actual = () => { const id = guardada(); const act = items.filter((x) => (x.status || 'active') === 'active'); return id && act.some((x) => x.id === id) ? id : act.length === 1 ? act[0].id : ''; };
    const pintar = () => {
      const act = items.filter((x) => (x.status || 'active') === 'active');
      sel.innerHTML = `<option value="" disabled ${actual() ? '' : 'selected'}>Selecciona ${esc(amb.articulo || 'un')} ${esc(amb.etiqueta.toLowerCase())}</option>` + act.map((x) => `<option value="${esc(x.id)}" ${x.id === actual() ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
      document.querySelector('[data-sede-box]').classList.toggle('need', !actual() && act.length > 1);
    };
    const cargar = () => api(amb.api).then((d) => { items = d.items || d.rows || []; pintar(); }).catch(() => {});
    sel.addEventListener('change', () => {
      try { localStorage.setItem(KEY, sel.value); } catch (_) {}
      pintar();
      frame.contentWindow?.postMessage({ dw: 'sede', id: sel.value }, location.origin);
    });
    // Las páginas avisan cuando eligen una sede (tarjetas del Inicio, selector inicial) o cuando cambia la lista
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
      if (e.data?.dw === 'sede') { try { localStorage.setItem(KEY, e.data.id || ''); } catch (_) {} pintar(); }
      if (e.data?.dw === 'sedes') cargar();
    });
    cargar();
  }

  function iniciarPanel() {
    const frame = document.getElementById('dw-frame');
    const OK = /^\/staff\/[\w\-./?=&%]*(#[\w\-]*)?$/;
    const go = new URLSearchParams(location.search).get('go');
    let ultimo = null; try { ultimo = sessionStorage.getItem('dw_ultimo'); } catch (_) {}
    frame.src = [go, ultimo, '/staff/'].find((u) => u && OK.test(u));
    history.replaceState(null, '', location.pathname);   // la dirección queda fija: /<dirección del negocio>
    const marcar = () => {
      document.querySelectorAll('.dw-nav a[data-mod], .dw-bottom a[data-mod]').forEach((a) => {
        const on = a.dataset.mod === panel.modulo;
        a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      });
      const mas = document.querySelector('.dw-bottom button');
      if (mas) mas.classList.toggle('active', ![...document.querySelectorAll('.dw-bottom a[data-mod]')].some((a) => a.dataset.mod === panel.modulo));
    };
    window.addEventListener('message', (e) => {
      if (e.origin === location.origin && e.source === frame.contentWindow && e.data?.dw === 'tema') { applyTheme(e.data); return; }
      if (e.origin === location.origin && e.source === frame.contentWindow && e.data?.dw === 'avisos' && Array.isArray(e.data.alertas)) {
        setNotifs(e.data.alertas.slice(0, 6).map((a) => ({ icono: String(a.icono || ''), texto: String(a.texto || '').slice(0, 200), ruta: /^[a-z]+$/.test(a.mod || '') ? `/staff/${a.mod}.html` : null })));
        return;
      }
      if (e.origin !== location.origin || e.source !== frame.contentWindow || e.data?.dw !== 'page') return;
      panel.modulo = e.data.modulo; panel.titulo = e.data.titulo || '';
      const t = document.querySelector('[data-top-title]'); if (t) t.textContent = panel.titulo;
      document.title = `${panel.titulo ? panel.titulo + ' · ' : ''}${DW.me.business.name} · ${DW.me.app.nombre}`;
      marcar();
      try { if (OK.test(e.data.url)) sessionStorage.setItem('dw_ultimo', e.data.url); } catch (_) {}
    });
    document.addEventListener('click', (e) => {
      const g = e.target.closest('a[data-go]');
      if (g && /^\/staff\/[\w\-.]+$/.test(g.dataset.go)) { e.preventDefault(); frame.src = g.dataset.go; return; }
      const a = e.target.closest('a[data-mod]');
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      frame.src = a.getAttribute('href');
      const oc = document.getElementById('dwSide'); if (oc) window.bootstrap?.Offcanvas.getInstance(oc)?.hide();
    });
  }

  const ready = api('/api/me').then((me) => {
    applyTheme(me.settings);
    me.canManage = RANK[me.role] >= RANK.admin;
    me.reaches = (min) => (RANK[me.role] || 0) >= (RANK[min] || 1);
    me.pageAllowed = render(me);
    window.DW.me = me;
    return me;
  }).catch((e) => {
    if (e.code === 'NO_BUSINESS' || e.status === 401) aInicio();
    throw e;
  });

  window.DW = { ready, applyTheme };
})();

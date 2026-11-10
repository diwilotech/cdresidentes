// Pendientes de la administración para la IA proactiva (botón «IA Diwilo» → «Lo de hoy»). Los pide el módulo central de IA por
// ctx.propias.pendientes() (src/lib/central.js). Sin IA: usa las mismas herramientas de lectura del MCP (`usar` respeta módulo activo y rol).
// Cada uno: { id, nivel: mala|aviso|info, icono, texto, ruta, pregunta } — `pregunta` es lo que la persona le pediría a la IA para atenderlo.
const peso = (n) => `$${Math.round(n || 0).toLocaleString('es-CO')}`;
const pl = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

export async function pendientesDe(usar) {
  const [car, pq, sol, res] = await Promise.all([
    usar('cartera.resumen_cartera'), usar('pqrs.listar_pqrs', { status: 'open' }),
    usar('porteria.listar_solicitudes', { status: 'pending' }), usar('reservas.listar_reservas', { status: 'pending' }),
  ]);
  const out = [];
  if (car?.overdue > 0) out.push({ id: 'cr-cartera', nivel: 'mala', icono: 'bi-cash-coin', texto: `${peso(car.overdue)} de cartera vencida${Number(car.debtors) > 0 ? ` en ${pl(Number(car.debtors), 'unidad', 'unidades')}` : ''}`, ruta: '/staff/cartera.html', pregunta: '¿Qué unidades deben más y a quién le cobro primero?' });
  const nPq = pq?.pqrs?.length || 0;
  if (nPq) out.push({ id: 'cr-pqrs', nivel: 'aviso', icono: 'bi-chat-square-text', texto: `${pl(nPq, 'PQRS abierta sin responder', 'PQRS abiertas sin responder')}`, ruta: '/staff/pqrs.html', pregunta: '¿Qué PQRS llevan más tiempo sin respuesta?' });
  const nSol = sol?.solicitudes?.length || 0;
  if (nSol) out.push({ id: 'cr-porteria', nivel: 'aviso', icono: 'bi-door-open', texto: `${pl(nSol, 'solicitud de portería espera', 'solicitudes de portería esperan')} respuesta`, ruta: '/staff/porteria.html', pregunta: '¿Qué solicitudes de portería debo resolver hoy?' });
  const nRes = res?.reservas?.length || 0;
  if (nRes) out.push({ id: 'cr-reservas', nivel: 'info', icono: 'bi-calendar-check', texto: `${pl(nRes, 'reserva de zona común por aprobar', 'reservas de zonas comunes por aprobar')}`, ruta: '/staff/porteria.html', pregunta: '¿Qué reservas tengo por aprobar?' });
  return out;
}

// Diwilo Residential AI: chat de la administración con Workers AI (binding AI).
// Cada respuesta se arma con un resumen en vivo de los datos del negocio (siempre filtrados por business_id):
// cartera y deudores, PQRS abiertas, solicitudes de portería, reservas y comunicados recientes.
import { json, readJson, str, oneOf, HttpError } from '../lib/http.js';
import { tenantDb, uuid } from '../lib/db.js';
import { getRow } from '../lib/crud.js';
import { today } from '../lib/time.js';
import { UNIT_DEBT_SQL, unitLabel } from './units.js';
import { CONCEPTS } from './charges.js';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const HISTORY = 12; // mensajes previos que se envían al modelo

const money = (n) => '$' + Math.round(n || 0).toLocaleString('es-CO');

// Resumen compacto (texto) del negocio o de un conjunto para el prompt.
async function contextFor(c, propertyId) {
  const db = tenantDb(c);
  const t = today();
  const pf = propertyId ? ' AND property_id = ?' : '';
  const pa = propertyId ? [propertyId] : [];
  const [biz, props, debtors, totals, pqrs, reqs, bookings, notices, pets] = await Promise.all([
    db.first('SELECT name FROM businesses WHERE id = ? /* business_id */', c.businessId),
    db.all(
      `SELECT p.id, p.name, p.city, p.towers,
              (SELECT COUNT(*) FROM units u WHERE u.business_id = p.business_id AND u.property_id = p.id) AS units,
              (SELECT COALESCE(SUM(residents), 0) FROM units u WHERE u.business_id = p.business_id AND u.property_id = p.id) AS residents
         FROM properties p WHERE p.business_id = ? AND p.status = 'active'${propertyId ? ' AND p.id = ?' : ''} ORDER BY p.name`,
      c.businessId, ...pa,
    ),
    db.all(`SELECT * FROM (${UNIT_DEBT_SQL} WHERE u.business_id = ?${propertyId ? ' AND u.property_id = ?' : ''}) WHERE overdue > 0 ORDER BY overdue DESC LIMIT 20`, c.businessId, ...pa),
    db.first(
      `SELECT COALESCE(SUM(CASE WHEN ch.paid_at IS NULL AND ch.due_date < ? THEN ch.amount END), 0) AS overdue,
              COALESCE(SUM(CASE WHEN ch.paid_at >= ? THEN ch.amount END), 0) AS collected_month,
              COUNT(DISTINCT CASE WHEN ch.paid_at IS NULL AND ch.due_date < ? THEN ch.unit_id END) AS debtors,
              (SELECT COUNT(*) FROM units x WHERE x.business_id = ?${propertyId ? ' AND x.property_id = ?' : ''}) AS units
         FROM charges ch JOIN units u ON u.id = ch.unit_id WHERE ch.business_id = ?${propertyId ? ' AND u.property_id = ?' : ''}`,
      t, t.slice(0, 8) + '01', t, c.businessId, ...pa, c.businessId, ...pa,
    ),
    db.all(`SELECT subject, category, kind, priority, status, substr(created_at, 1, 10) AS date FROM pqrs WHERE business_id = ? AND status <> 'closed'${pf} ORDER BY created_at DESC LIMIT 15`, c.businessId, ...pa),
    db.all(`SELECT kind, title, status, scheduled_at FROM requests WHERE business_id = ? AND status IN ('pending','approved')${pf} ORDER BY COALESCE(scheduled_at, created_at) LIMIT 15`, c.businessId, ...pa),
    db.all(
      `SELECT b.date, b.start_time, b.end_time, b.status, a.name AS amenity FROM bookings b JOIN amenities a ON a.id = b.amenity_id
        WHERE b.business_id = ? AND b.date >= ? AND b.status IN ('pending','approved')${propertyId ? ' AND a.property_id = ?' : ''} ORDER BY b.date, b.start_time LIMIT 10`,
      c.businessId, t, ...pa,
    ),
    db.all(`SELECT title, category, substr(created_at, 1, 10) AS date FROM notices WHERE business_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 5`, c.businessId),
    db.first(
      `SELECT COUNT(*) AS total, COUNT(CASE WHEN vaccinated_until IS NULL OR vaccinated_until < ? THEN 1 END) AS unvaccinated
         FROM pets pt WHERE pt.business_id = ?${propertyId ? ' AND pt.unit_id IN (SELECT id FROM units WHERE business_id = ? AND property_id = ?)' : ''}`,
      t, c.businessId, ...(propertyId ? [c.businessId, propertyId] : []),
    ),
  ]);

  const lines = [
    `Administración: ${biz.name}. Fecha de hoy: ${t}.`,
    propertyId ? `Conjunto en foco: ${props[0]?.name || '—'}.` : `Conjuntos administrados: ${props.length}.`,
    ...props.map((p) => `- ${p.name}${p.city ? ` (${p.city})` : ''}: ${p.units} unidades, ${p.residents} habitantes${p.towers ? `, torres: ${p.towers}` : ''}`),
    '',
    `CARTERA: vencida ${money(totals.overdue)}; recaudado este mes ${money(totals.collected_month)}; ${totals.debtors} de ${totals.units} unidades en mora (${totals.units ? Math.round((totals.debtors / totals.units) * 100) : 0}%).`,
    debtors.length ? 'Unidades con mayor deuda vencida:' : 'No hay unidades en mora.',
    ...debtors.map((u) => {
      const days = u.oldest_due ? Math.round((Date.parse(t) - Date.parse(u.oldest_due)) / 864e5) : 0;
      return `- ${u.property_name} ${unitLabel(u)} · ${u.owner_name || 'sin propietario'} · debe ${money(u.overdue)} · ${days} días de atraso${u.owner_phone ? ' · tiene WhatsApp' : ''}`;
    }),
    '',
    `PQRS ABIERTAS (${pqrs.length}):`,
    ...pqrs.map((q) => `- [${q.category}/${q.priority}] ${q.subject} (${q.status}, ${q.date})`),
    '',
    `SOLICITUDES DE PORTERÍA PENDIENTES O APROBADAS (${reqs.length}):`,
    ...reqs.map((r) => `- ${r.kind}: ${r.title} (${r.status}${r.scheduled_at ? `, ${r.scheduled_at.replace('T', ' ')}` : ''})`),
    '',
    `PRÓXIMAS RESERVAS DE ZONAS COMUNES (${bookings.length}):`,
    ...bookings.map((b) => `- ${b.amenity}: ${b.date} ${b.start_time}-${b.end_time} (${b.status})`),
    '',
    `MASCOTAS: ${pets.total} registradas, ${pets.unvaccinated} sin vacunas al día.`,
    `ÚLTIMOS COMUNICADOS: ${notices.map((n) => `"${n.title}" (${n.date})`).join('; ') || 'ninguno'}.`,
  ];
  return lines.join('\n');
}

const SYSTEM = `Eres Diwilo Residential AI, asistente de la administración de propiedad horizontal (conjuntos residenciales en Colombia, Ley 675 de 2001).
Ayudas al administrador a: analizar la cartera y los deudores, redactar circulares y recordatorios de cobro cordiales pero firmes,
auditar PQRS y solicitudes de portería, y proponer acciones de convivencia.
Reglas:
- Responde siempre en español, claro y breve. Usa listas cuando ayuden y **negritas** para cifras clave.
- Usa SOLO los datos del bloque DATOS; si algo no está, dilo y sugiere dónde registrarlo en la app. No inventes cifras ni nombres.
- Valores en pesos colombianos con formato $1.234.567.
- Cuando redactes un comunicado o mensaje listo para enviar, ponlo entre las líneas ---INICIO--- y ---FIN--- para que la app ofrezca publicarlo o enviarlo por WhatsApp.
- Nunca compartas datos de una unidad con otra; los mensajes de cobro van dirigidos solo a su propietario.`;

async function runModel(env, messages) {
  if (!env.AI) throw new HttpError(503, 'El asistente de IA no está configurado en el servidor');
  try {
    const out = await env.AI.run(MODEL, { messages, max_tokens: 1200, temperature: 0.4 });
    const text = (out?.response || '').trim();
    if (!text) throw new Error('respuesta vacía');
    return text;
  } catch (err) {
    console.error('Workers AI', err);
    throw new HttpError(502, 'El asistente no pudo responder. Intenta de nuevo en un momento.');
  }
}

export function routes(r) {
  r.get('/api/admin/ai/chats', 'tenant', async (c) => {
    const items = await tenantDb(c).all(
      'SELECT id, title, property_id, updated_at FROM chats WHERE business_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 50',
      c.businessId, c.user.id,
    );
    return json({ items });
  });

  r.get('/api/admin/ai/chats/:id', 'tenant', async (c) => {
    const chat = await getRow(c, 'chats', c.params.id, 'Conversación');
    if (chat.user_id !== c.user.id) throw new HttpError(404, 'Conversación no encontrada');
    const messages = await tenantDb(c).all(
      'SELECT id, role, content, created_at FROM chat_messages WHERE business_id = ? AND chat_id = ? ORDER BY created_at, rowid',
      c.businessId, chat.id,
    );
    return json({ chat, messages });
  });

  r.delete('/api/admin/ai/chats/:id', 'tenant', async (c) => {
    const chat = await getRow(c, 'chats', c.params.id, 'Conversación');
    if (chat.user_id !== c.user.id) throw new HttpError(404, 'Conversación no encontrada');
    await tenantDb(c).run('DELETE FROM chats WHERE business_id = ? AND id = ?', c.businessId, chat.id);
    return json({ ok: true });
  });

  // body: { chat_id?, message, property_id? } -> { chat_id, answer }
  r.post('/api/admin/ai/chat', 'tenant', async (c) => {
    const body = await readJson(c.req);
    const message = str(body.message, { required: true, max: 4000, label: 'Mensaje' });
    const db = tenantDb(c);
    let chat;
    if (body.chat_id) {
      chat = await getRow(c, 'chats', String(body.chat_id), 'Conversación');
      if (chat.user_id !== c.user.id) throw new HttpError(404, 'Conversación no encontrada');
    } else {
      const propertyId = str(body.property_id, { max: 40 });
      if (propertyId) await getRow(c, 'properties', propertyId, 'Conjunto');
      chat = { id: uuid(), property_id: propertyId };
      await db.run(
        'INSERT INTO chats (id, business_id, user_id, property_id, title) VALUES (?, ?, ?, ?, ?)',
        chat.id, c.businessId, c.user.id, chat.property_id, message.slice(0, 60),
      );
    }
    const history = (await db.all(
      'SELECT role, content FROM chat_messages WHERE business_id = ? AND chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      c.businessId, chat.id, HISTORY,
    )).reverse();
    const context = await contextFor(c, chat.property_id);
    const answer = await runModel(c.env, [
      { role: 'system', content: `${SYSTEM}\n\nDATOS (en vivo, de la base de la administración):\n${context}` },
      ...history,
      { role: 'user', content: message },
    ]);
    await db.batch([
      db.prepare('INSERT INTO chat_messages (id, business_id, chat_id, role, content) VALUES (?, ?, ?, ?, ?)', uuid(), c.businessId, chat.id, 'user', message),
      db.prepare(`INSERT INTO chat_messages (id, business_id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+1 second'))`, uuid(), c.businessId, chat.id, 'assistant', answer),
      db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE business_id = ? AND id = ?`, c.businessId, chat.id),
    ]);
    return json({ chat_id: chat.id, answer });
  });

  // Borradores rápidos: recordatorio de cobro para una unidad o circular sobre un tema.
  // body: { kind: 'cobro', unit_id } | { kind: 'circular', topic, property_id? }
  r.post('/api/admin/ai/draft', 'tenant', async (c) => {
    const body = await readJson(c.req);
    const kind = oneOf(body.kind, ['cobro', 'circular'], { label: 'Tipo', fallback: 'circular' });
    let prompt;
    if (kind === 'cobro') {
      const u = await tenantDb(c).first(`${UNIT_DEBT_SQL} WHERE u.business_id = ? AND u.id = ?`, c.businessId, str(body.unit_id, { required: true, label: 'Unidad' }));
      if (!u) throw new HttpError(404, 'Unidad no encontrada');
      const items = await tenantDb(c).all(
        'SELECT concept, period, amount, due_date FROM charges WHERE business_id = ? AND unit_id = ? AND paid_at IS NULL ORDER BY due_date',
        c.businessId, u.id,
      );
      prompt = `Redacta un mensaje de WhatsApp cordial pero firme para ${u.owner_name || 'el propietario'} de la unidad ${unitLabel(u)} del conjunto ${u.property_name},
recordando su saldo pendiente de ${money(u.balance)} (vencido: ${money(u.overdue)}).
Detalle: ${items.map((i) => `${CONCEPTS[i.concept]}${i.period ? ` ${i.period}` : ''}: ${money(i.amount)} (vence ${i.due_date})`).join('; ') || 'sin detalle'}.
Máximo 600 caracteres, sin saludos genéricos de IA, invita a ponerse al día o acordar un plan de pagos con la administración. Solo el texto del mensaje.`;
    } else {
      const topic = str(body.topic, { required: true, max: 500, label: 'Tema' });
      const prop = body.property_id ? await getRow(c, 'properties', String(body.property_id), 'Conjunto') : null;
      prompt = `Redacta una circular oficial para los residentes${prop ? ` del conjunto ${prop.name}` : ''} sobre: ${topic}.
Tono respetuoso y claro, con fecha de hoy (${today()}), máximo 1200 caracteres. Devuelve en la primera línea el título y luego el cuerpo, sin firmas inventadas.`;
    }
    const text = await runModel(c.env, [
      { role: 'system', content: 'Eres el asistente de redacción de una administración de propiedad horizontal en Colombia. Escribe en español.' },
      { role: 'user', content: prompt },
    ]);
    return json({ text: text.replace(/^---INICIO---|---FIN---$/g, '').trim() });
  });
}

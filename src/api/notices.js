// Comunicados y circulares; envío a residentes por correo (Gmail SMTP) y WhatsApp (Evolution API).
import { json, readJson, str, oneOf, HttpError } from '../lib/http.js';
import { tenantDb } from '../lib/db.js';
import { pick, insertRow, updateRow, deleteRow, getRow, propertyFilter, searchFilter } from '../lib/crud.js';
import { sendWhatsApp, normalizePhone } from '../integrations/whatsapp.js';
import { sendMail } from '../integrations/email.js';
import { today } from '../lib/time.js';

export const NOTICE_CATEGORIES = ['mantenimiento', 'seguridad', 'servicios', 'asamblea', 'convivencia', 'finanzas', 'general'];
const MAX_WA = 150; // tope por envío (límite de subpeticiones del Worker)

const FIELDS = {
  property_id: (v) => str(v, { max: 40, label: 'Conjunto' }),
  title: (v) => str(v, { required: true, max: 160, label: 'Título' }),
  category: (v) => oneOf(v, NOTICE_CATEGORIES, { label: 'Categoría', fallback: 'general' }),
  body: (v) => str(v, { required: true, max: 8000, label: 'Contenido' }),
  status: (v) => oneOf(v, ['draft', 'published', 'archived'], { label: 'Estado', fallback: 'published' }),
};

const escHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// Destinatarios: propietarios y arrendatarios de las unidades (todas o solo las que están en mora).
async function recipients(c, propertyId, audience) {
  const args = [c.businessId];
  let sql = 'SELECT u.* FROM units u WHERE u.business_id = ?';
  if (propertyId) { sql += ' AND u.property_id = ?'; args.push(propertyId); }
  if (audience === 'debtors') {
    sql += ` AND EXISTS (SELECT 1 FROM charges ch WHERE ch.business_id = u.business_id AND ch.unit_id = u.id AND ch.paid_at IS NULL AND ch.due_date < ?)`;
    args.push(today());
  }
  const units = await tenantDb(c).all(sql, ...args);
  const emails = new Set();
  const phones = new Set();
  for (const u of units) {
    const people = audience === 'owners' || audience === 'debtors' ? [['owner_email', 'owner_phone']] : [['owner_email', 'owner_phone'], ['tenant_email', 'tenant_phone']];
    for (const [e, p] of people) {
      if (u[e]) emails.add(u[e]);
      if (u[p]) { try { phones.add(normalizePhone(u[p], c.env)); } catch { /* número inválido: se omite */ } }
    }
  }
  return { units: units.length, emails: [...emails], phones: [...phones] };
}

async function sendWaMany(c, instance, phones, text) {
  let ok = 0;
  for (const phone of phones.slice(0, MAX_WA)) {
    try { await sendWhatsApp(c.env, instance, phone, text); ok++; } catch (err) {
      if (err.status === 503 || err.status === 400) throw err; // sin configurar: no sigue intentando
    }
  }
  return ok;
}

export function routes(r) {
  r.get('/api/admin/notices', 'tenant', async (c) => {
    const sp = c.url.searchParams;
    const [pf, pa] = propertyFilter(c, 'n.property_id');
    const [qf, qa] = searchFilter(c, ['n.title', 'n.body']);
    let extra = '';
    const ea = [];
    if (sp.get('status')) { extra += ' AND n.status = ?'; ea.push(sp.get('status')); } else extra += " AND n.status <> 'archived'";
    if (sp.get('category')) { extra += ' AND n.category = ?'; ea.push(sp.get('category')); }
    // Con conjunto elegido también se ven los comunicados generales (property_id NULL).
    const items = await tenantDb(c).all(
      `SELECT n.*, p.name AS property_name, us.name AS author
         FROM notices n LEFT JOIN properties p ON p.id = n.property_id LEFT JOIN users us ON us.id = n.created_by
        WHERE n.business_id = ?${pf ? ` AND (n.property_id IS NULL OR n.property_id = ?)` : ''}${qf}${extra}
        ORDER BY n.created_at DESC LIMIT 200`,
      c.businessId, ...pa, ...qa, ...ea,
    );
    return json({ items });
  });

  r.post('/api/admin/notices', 'tenant', async (c) => {
    const id = await insertRow(c, 'notices', { ...pick(await readJson(c.req), FIELDS), created_by: c.user.id });
    return json({ id }, 201);
  });

  r.put('/api/admin/notices/:id', 'tenant', async (c) => {
    await updateRow(c, 'notices', c.params.id, pick(await readJson(c.req), FIELDS, { partial: true }));
    return json({ ok: true });
  });

  r.delete('/api/admin/notices/:id', 'manager', async (c) => {
    await deleteRow(c, 'notices', c.params.id);
    return json({ ok: true });
  });

  // Cuántos destinatarios tendría un envío (para confirmar antes de enviar).
  r.get('/api/admin/notices/:id/recipients', 'tenant', async (c) => {
    const n = await getRow(c, 'notices', c.params.id, 'Comunicado');
    const rc = await recipients(c, n.property_id, c.url.searchParams.get('audience') || 'all');
    return json({ units: rc.units, emails: rc.emails.length, phones: Math.min(rc.phones.length, MAX_WA) });
  });

  // Envía el comunicado. body: { channels: ['email','whatsapp'], audience: 'all'|'owners'|'debtors' }
  r.post('/api/admin/notices/:id/send', 'manager', async (c) => {
    const body = await readJson(c.req);
    const n = await getRow(c, 'notices', c.params.id, 'Comunicado');
    const channels = Array.isArray(body.channels) ? body.channels : [];
    if (!channels.length) throw new HttpError(400, 'Elige al menos un canal');
    const audience = oneOf(body.audience, ['all', 'owners', 'debtors'], { label: 'Destinatarios', fallback: 'all' });
    const rc = await recipients(c, n.property_id, audience);
    const b = await tenantDb(c).first('SELECT name, email, wa_instance FROM businesses WHERE id = ? /* business_id */', c.businessId);
    const prop = n.property_id ? await getRow(c, 'properties', n.property_id, 'Conjunto') : null;
    const from = prop ? `${prop.name} · ${b.name}` : b.name;
    const out = { email: 0, whatsapp: 0 };

    if (channels.includes('email') && rc.emails.length) {
      await sendMail(c.env, {
        bcc: rc.emails,
        subject: `${n.title} · ${from}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:560px">
          <p style="color:#047857;font-weight:600;margin:0 0 4px">${escHtml(from)}</p>
          <h2 style="margin:0 0 12px">${escHtml(n.title)}</h2>
          <div style="white-space:pre-wrap;line-height:1.5">${escHtml(n.body)}</div></div>`,
        replyTo: prop?.email || b.email || undefined,
      });
      out.email = rc.emails.length;
    }
    if (channels.includes('whatsapp') && rc.phones.length) {
      out.whatsapp = await sendWaMany(c, b.wa_instance, rc.phones, `*${n.title}*\n_${from}_\n\n${n.body}`);
    }
    await tenantDb(c).run(
      `UPDATE notices SET sent_email = sent_email + ?, sent_wa = sent_wa + ?, status = 'published', updated_at = datetime('now')
        WHERE business_id = ? AND id = ?`,
      out.email, out.whatsapp, c.businessId, n.id,
    );
    return json({ ok: true, sent: out });
  });

  // Mensaje directo a una unidad (recordatorio de cobro, novedad…).
  // body: { channel: 'whatsapp'|'email', to: 'owner'|'tenant', text, subject? }
  r.post('/api/admin/units/:id/message', 'tenant', async (c) => {
    const body = await readJson(c.req);
    const u = await getRow(c, 'units', c.params.id, 'Unidad');
    const channel = oneOf(body.channel, ['whatsapp', 'email'], { label: 'Canal', fallback: 'whatsapp' });
    const who = oneOf(body.to, ['owner', 'tenant'], { label: 'Destinatario', fallback: 'owner' });
    const text = str(body.text, { required: true, max: 4000, label: 'Mensaje' });
    const b = await tenantDb(c).first('SELECT name, email, wa_instance FROM businesses WHERE id = ? /* business_id */', c.businessId);
    if (channel === 'whatsapp') {
      const phone = u[`${who}_phone`];
      if (!phone) throw new HttpError(400, 'La unidad no tiene celular registrado para ese destinatario');
      await sendWhatsApp(c.env, b.wa_instance, phone, text);
    } else {
      const to = u[`${who}_email`];
      if (!to) throw new HttpError(400, 'La unidad no tiene correo registrado para ese destinatario');
      await sendMail(c.env, {
        to,
        subject: str(body.subject, { max: 160 }) || `Mensaje de la administración · ${b.name}`,
        html: `<div style="font-family:system-ui,sans-serif;white-space:pre-wrap;line-height:1.5">${escHtml(text)}</div>`,
        replyTo: b.email || undefined,
      });
    }
    return json({ ok: true });
  });
}

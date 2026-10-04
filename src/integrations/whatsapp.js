// WhatsApp vía Evolution API (v2).
// Servidor global: EVOLUTION_URL + EVOLUTION_KEY. Cada negocio usa su propia instancia (businesses.wa_instance).

import { HttpError } from '../lib/http.js';

export function normalizePhone(phone, env) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = (env.DEFAULT_COUNTRY_CODE || '57') + digits;
  if (digits.length < 11 || digits.length > 15) throw new HttpError(400, 'Número de WhatsApp inválido');
  return digits;
}

export async function sendWhatsApp(env, instance, phone, text) {
  if (!env.EVOLUTION_URL || !env.EVOLUTION_KEY) throw new HttpError(503, 'WhatsApp no está configurado en el servidor');
  if (!instance) throw new HttpError(400, 'Este negocio no tiene instancia de WhatsApp configurada');
  const url = `${env.EVOLUTION_URL.replace(/\/$/, '')}/message/sendText/${encodeURIComponent(instance)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: env.EVOLUTION_KEY },
    body: JSON.stringify({ number: normalizePhone(phone, env), text }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    console.error('Evolution API', res.status, detail);
    throw new HttpError(502, `WhatsApp respondió ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

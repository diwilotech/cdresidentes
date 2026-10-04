// Correo vía SMTP de Gmail (TLS implícito, puerto 465) usando sockets TCP de Workers.
// Requiere SMTP_USER y SMTP_PASS (contraseña de aplicación de Google).

import { connect } from 'cloudflare:sockets';
import { HttpError } from '../lib/http.js';

const enc = new TextEncoder();
const b64 = (s) => {
  let bin = '';
  for (const byte of enc.encode(s)) bin += String.fromCharCode(byte);
  return btoa(bin);
};
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

function lineReader(readable) {
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return async function readReply() {
    // Respuesta SMTP: líneas "250-..." continúan, "250 ..." termina.
    const lines = [];
    for (;;) {
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) return { code: +line.slice(0, 3), text: lines.join('\n') };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP: conexión cerrada');
      buf += dec.decode(value, { stream: true });
    }
  };
}

// bcc: lista de destinatarios ocultos (circulares a todos los residentes en un solo envío).
export async function sendMail(env, { to, bcc = [], subject, html, text, replyTo }) {
  if (!env.SMTP_USER || !env.SMTP_PASS) throw new HttpError(503, 'Correo no está configurado en el servidor');
  const socket = connect(
    { hostname: env.SMTP_HOST || 'smtp.gmail.com', port: Number(env.SMTP_PORT || 465) },
    { secureTransport: 'on' },
  );
  const writer = socket.writable.getWriter();
  const read = lineReader(socket.readable);
  const send = (line) => writer.write(enc.encode(line + '\r\n'));
  const expect = async (code) => {
    const r = await read();
    if (r.code !== code) throw new HttpError(502, `SMTP ${r.code}: ${r.text.slice(0, 120)}`);
  };

  const from = env.SMTP_USER;
  const fromName = env.APP_NAME || 'CD Residentes';
  const boundary = 'b' + crypto.randomUUID().replace(/-/g, '');
  const body64 = (s) => b64(s).replace(/.{1,76}/g, '$&\r\n');
  const message = [
    `From: ${encodeHeader(fromName)} <${from}>`,
    to ? `To: <${to}>` : `To: ${encodeHeader(fromName)} <${from}>`,
    replyTo ? `Reply-To: <${replyTo}>` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body64(text || html.replace(/<[^>]+>/g, ' ')),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body64(html || text),
    `--${boundary}--`,
  ].filter((l) => l !== null).join('\r\n');

  try {
    await expect(220);
    await send('EHLO cdresidentes.diwilo.com');
    await expect(250);
    await send('AUTH LOGIN');
    await expect(334);
    await send(b64(env.SMTP_USER));
    await expect(334);
    await send(b64(env.SMTP_PASS));
    await expect(235);
    await send(`MAIL FROM:<${from}>`);
    await expect(250);
    for (const rcpt of [to, ...bcc].filter(Boolean)) {
      await send(`RCPT TO:<${rcpt}>`);
      await expect(250);
    }
    await send('DATA');
    await expect(354);
    // Base64 no produce líneas que empiecen con '.', así que no hace falta dot-stuffing.
    await send(message + '\r\n.');
    await expect(250);
    await send('QUIT');
  } finally {
    socket.close().catch(() => {});
  }
}

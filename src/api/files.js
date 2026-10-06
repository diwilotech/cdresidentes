// Fotos y documentos en R2.
//   Adjuntos:  <business_id>/<ref_type>/<ref_id>/<uuid>  (actas, soportes, evidencias, fotos de mascotas)
//   Logos:     <business_id>/brand/<uuid>                 (administración y conjuntos; públicos)
import { json, HttpError, oneOf } from '../lib/http.js';
import { tenantDb, uuid } from '../lib/db.js';
import { getRow } from '../lib/crud.js';

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/;
const REF_TABLES = {
  property: 'properties', unit: 'units', pqrs: 'pqrs', request: 'requests', notice: 'notices', charge: 'charges', pet: 'pets',
};

// URL pública de un logo (las claves de marca no llevan datos privados).
export const brandUrl = (key) => (key ? `/api/public/brand/${key.replace('/brand/', '/')}` : null);

// Imagen de logo: PNG/JPG/WebP, máximo 3 MB.
export async function readImage(c) {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'Adjunta una imagen');
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new HttpError(415, 'La imagen debe ser PNG, JPG o WebP');
  if (file.size > 3 * 1024 * 1024) throw new HttpError(413, 'La imagen supera 3 MB');
  return file;
}

function refFrom(c) {
  const type = oneOf(c.url.searchParams.get('ref_type'), Object.keys(REF_TABLES), { label: 'Tipo' });
  const id = c.url.searchParams.get('ref_id');
  if (!type || !id) throw new HttpError(400, 'Falta a qué pertenece el archivo');
  return { type, id };
}

// Guarda el archivo del formulario (campo 'file') en R2 y lo registra en files. La referencia ya debe estar validada.
export async function saveUpload(c, type, refId, { imagesOnly = false } = {}) {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'Adjunta un archivo');
  if (file.size > MAX_BYTES) throw new HttpError(413, 'El archivo supera 15 MB');
  if (!ALLOWED.test(file.type)) throw new HttpError(415, 'Solo se permiten imágenes o PDF');
  if (imagesOnly && !file.type.startsWith('image/')) throw new HttpError(415, 'Adjunta una imagen');

  const id = uuid();
  const key = `${c.businessId}/${type}/${refId}/${id}`;
  const name = (file.name || 'archivo').replace(/[^\w.\- áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 120);
  await c.env.FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { businessId: c.businessId, refType: type, refId, name },
  });
  await tenantDb(c).run(
    `INSERT INTO files (id, business_id, ref_type, ref_id, r2_key, name, content_type, size, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, c.businessId, type, refId, key, name, file.type, file.size, c.user.id,
  );
  return { id, name };
}

// Respuesta con el contenido de un archivo (fila de files).
export async function serveFile(c, f) {
  const obj = await c.env.FILES.get(f.r2_key);
  if (!obj) throw new HttpError(404, 'Archivo no encontrado en almacenamiento');
  const disposition = c.url.searchParams.get('download') ? 'attachment' : 'inline';
  return new Response(obj.body, {
    headers: {
      'content-type': f.content_type || 'application/octet-stream',
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function routes(r) {
  r.get('/api/public/brand/:bid/:file', 'public', async (c) => {
    if (!/^[\w-]{36}$/.test(c.params.bid) || !/^[\w-]{36}$/.test(c.params.file)) throw new HttpError(404, 'No encontrado');
    const obj = await c.env.FILES.get(`${c.params.bid}/brand/${c.params.file}`);
    if (!obj) throw new HttpError(404, 'No encontrado');
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType || 'image/png',
        'cache-control': 'public, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  r.get('/api/admin/files', 'tenant', async (c) => {
    const { type, id } = refFrom(c);
    const items = await tenantDb(c).all(
      `SELECT id, name, content_type, size, created_at FROM files
        WHERE business_id = ? AND ref_type = ? AND ref_id = ? ORDER BY created_at DESC`,
      c.businessId, type, id,
    );
    return json({ items });
  });

  r.post('/api/admin/files', 'tenant', async (c) => {
    const { type, id: refId } = refFrom(c);
    await getRow(c, REF_TABLES[type], refId);
    return json(await saveUpload(c, type, refId), 201);
  });

  r.get('/api/admin/files/:id', 'tenant', async (c) => {
    const f = await tenantDb(c).first('SELECT * FROM files WHERE business_id = ? AND id = ?', c.businessId, c.params.id);
    if (!f) throw new HttpError(404, 'Archivo no encontrado');
    return serveFile(c, f);
  });

  r.delete('/api/admin/files/:id', 'tenant', async (c) => {
    const db = tenantDb(c);
    const f = await db.first('SELECT r2_key FROM files WHERE business_id = ? AND id = ?', c.businessId, c.params.id);
    if (!f) throw new HttpError(404, 'Archivo no encontrado');
    await c.env.FILES.delete(f.r2_key);
    await db.run('DELETE FROM files WHERE business_id = ? AND id = ?', c.businessId, c.params.id);
    return json({ ok: true });
  });
}

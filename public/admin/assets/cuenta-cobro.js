// Cuenta de cobro en PDF (pdfmake, en el navegador) con los cortes por mes de cada concepto de la cartera.
// Formatos (Ajustes → Cartera y cuenta de cobro):
//   half          media carta (21,6 × 14 cm), una cuenta por hoja
//   letter_copy   carta: la misma cuenta dos veces, ORIGINAL (propietario) y COPIA (administración), con línea de corte
//   letter_series carta: dos cuentas distintas por hoja (impresión en serie de todo el conjunto), con línea de corte
// Uso: CuentaCobro.open({ unit: id }) · CuentaCobro.open({ property: id, all: false, format: 'letter_series' })
'use strict';

const CuentaCobro = (() => {
  const W = 612;           // ancho carta en puntos
  const HALF = 396;        // media carta (alto)
  const M = 26;            // margen
  const INK = '#0F1F1A', MUTED = '#5B6B66', ACCENT = '#047857', LINE = '#CFD8D4';
  const ORDER = ['admin', 'rtc', 'ext', 'parking', 'jur', 'int', 'other'];
  const SHORT = { admin: 'ADM', rtc: 'RTC', ext: 'EXT', parking: 'PAR', jur: 'JUR', int: 'INT', other: 'OTR' };

  const money = (n) => '$ ' + Math.round(Number(n) || 0).toLocaleString('es-CO');
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const fdate = (iso) => (iso ? `${+iso.slice(8, 10)} ${MESES[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : '—');
  const fper = (ym) => `${MESES[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;

  // Imagen a dataURL (pdfmake solo acepta PNG y JPG).
  const images = {};
  async function dataUrl(url) {
    if (!url) return null;
    if (url in images) return images[url];
    try {
      const blob = await (await fetch(url)).blob();
      if (!/^image\/(png|jpe?g)$/.test(blob.type)) return (images[url] = null);
      images[url] = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    } catch { images[url] = null; }
    return images[url];
  }

  // Cortes por mes: una fila por mes de vencimiento y una columna por concepto, con lo pendiente de cada corte.
  // Más de 7 meses: los más antiguos se agrupan en "Anteriores" para que quepa en media carta.
  // Conceptos de la cuenta: los activos en Ajustes + los que esta unidad tenga con saldo (para que el total cuadre).
  const keysFor = (data, st) => ORDER.filter((k) => k === 'admin' || (data.billing.concepts || ORDER).includes(k) || st.concepts[k] > 0);

  function cutsTable(data, st) {
    const t = data.issued;
    const KEYS = keysFor(data, st);
    const num = (n) => (n ? Math.round(n).toLocaleString('es-CO') : '—');
    let groups = [...new Set(st.items.map((i) => i.due_date.slice(0, 7)))].sort().map((m) => ({ label: fper(m), keys: [m] }));
    if (groups.length > 7) {
      const old = groups.slice(0, groups.length - 6);
      groups = [{ label: `Anteriores (${old.length})`, keys: old.flatMap((g) => g.keys) }, ...groups.slice(-6)];
    }
    const sum = (keys, k) => st.items.filter((i) => keys.includes(i.due_date.slice(0, 7)) && (!k || i.concept === k)).reduce((s, i) => s + i.amount, 0);
    const overdue = (keys) => st.items.some((i) => keys.includes(i.due_date.slice(0, 7)) && i.due_date < t);
    const body = [
      [{ text: 'Corte (mes)', style: 'th' }, ...KEYS.map((k) => ({ text: SHORT[k], style: 'th', alignment: 'right' })), { text: 'Total', style: 'th', alignment: 'right' }],
      ...(groups.length ? groups.map((g) => [
        { text: [g.label, overdue(g.keys) ? { text: '  vencido', color: '#B91C1C', fontSize: 6.5 } : { text: '  por vencer', color: MUTED, fontSize: 6.5 }] },
        ...KEYS.map((k) => { const v = sum(g.keys, k); return { text: num(v), alignment: 'right', color: v ? INK : '#9CA3AF' }; }),
        { text: num(sum(g.keys)), alignment: 'right', bold: true },
      ]) : [[{ text: 'Sin saldos pendientes: paz y salvo', colSpan: KEYS.length + 2, color: ACCENT, alignment: 'center' }, ...KEYS.map(() => ({})), {}]]),
      [{ text: 'TOTAL', bold: true, fillColor: '#ECFDF5' }, ...KEYS.map((k) => ({ text: num(st.concepts[k] || 0), alignment: 'right', bold: true, fillColor: '#ECFDF5' })),
        { text: num(st.total), alignment: 'right', bold: true, fillColor: '#ECFDF5' }],
      [{ text: [{ text: 'TOTAL A PAGAR', bold: true }, { text: `   Vencido ${money(st.overdue)}  ·  Por vencer ${money(st.total - st.overdue)}`, color: MUTED, fontSize: 7 }], colSpan: KEYS.length + 1 },
        ...KEYS.map(() => ({})), { text: money(st.total), bold: true, fontSize: 11, alignment: 'right', color: st.total ? INK : ACCENT }],
    ];
    return {
      table: { headerRows: 1, widths: [84, ...KEYS.map(() => '*'), 66], body },
      layout: { hLineColor: () => LINE, vLineWidth: () => 0, hLineWidth: (i, node) => (i === 1 || i >= node.table.body.length - 2 ? 1 : 0.4), paddingTop: () => 2.2, paddingBottom: () => 2.2, paddingLeft: () => 3, paddingRight: () => 3 },
      fontSize: 7.5,
    };
  }

  // Una cuenta de cobro: cabe en media carta (alto útil 396 - 2M).
  function block(data, st, label, logo) {
    const p = st.property || {};
    const u = st.unit;
    const t = data.issued;
    const width = W - 2 * M;
    return {
      unbreakable: true,
      stack: [
        {
          columns: [
            ...(logo ? [{ image: logo, fit: [44, 44], width: 50 }] : []),
            {
              width: '*',
              stack: [
                { text: p.name || '', bold: true, fontSize: 12, color: INK },
                { text: [p.nit && `NIT ${p.nit}`, [p.address, p.city].filter(Boolean).join(', '), p.phone && `Tel. ${p.phone}`].filter(Boolean).join('  ·  '), fontSize: 7.5, color: MUTED, margin: [0, 2, 0, 0] },
                { text: `Administración: ${data.business.name}${p.email || data.business.email ? '  ·  ' + (p.email || data.business.email) : ''}`, fontSize: 7.5, color: MUTED },
              ],
            },
            {
              width: 176,
              table: {
                widths: ['*', 'auto'],
                body: [
                  [{ text: 'CUENTA DE COBRO', colSpan: 2, bold: true, color: '#fff', fillColor: ACCENT, alignment: 'center', fontSize: 9 }, {}],
                  [{ text: 'N.º', color: MUTED }, { text: st.number, bold: true, alignment: 'right' }],
                  [{ text: 'Fecha', color: MUTED }, { text: fdate(t), alignment: 'right' }],
                  [{ text: 'Periodo', color: MUTED }, { text: fper(data.period), alignment: 'right' }],
                  [{ text: 'Pague hasta', color: MUTED }, { text: fdate(data.pay_before), alignment: 'right', bold: true }],
                ],
              },
              layout: { hLineColor: () => LINE, vLineColor: () => LINE, paddingTop: () => 1.5, paddingBottom: () => 1.5 },
              fontSize: 7.5,
            },
          ],
          columnGap: 10,
        },
        {
          margin: [0, 7, 0, 5],
          table: {
            widths: ['*', 'auto'],
            body: [[
              { text: [{ text: 'Propietario: ', color: MUTED }, { text: u.owner_name || '—', bold: true }, u.owner_doc ? { text: `  ·  Doc. ${u.owner_doc}`, color: MUTED } : '',
                u.tenant_name ? { text: `\nResidente: ${u.tenant_name}`, color: MUTED } : ''] },
              { text: [{ text: 'Unidad: ', color: MUTED }, { text: u.label, bold: true },
                { text: `${u.coefficient != null ? `  ·  Coef. ${Number(u.coefficient).toLocaleString('es-CO')} %` : ''}${u.area_m2 ? `  ·  ${u.area_m2} m²` : ''}`, color: MUTED }], alignment: 'right' },
            ]],
          },
          layout: { hLineColor: () => LINE, vLineWidth: () => 0, paddingTop: () => 3, paddingBottom: () => 3 },
          fontSize: 8,
        },
        cutsTable(data, st),
        { text: keysFor(data, st).map((k) => `${SHORT[k]} ${data.concepts[k]}`).join('  ·  '), fontSize: 6, color: MUTED, margin: [0, 2, 0, 0] },
        {
          margin: [0, 6, 0, 0],
          columns: [
            {
              width: '*',
              stack: [
                p.payment_info ? { text: [{ text: 'Forma de pago: ', bold: true }, p.payment_info], fontSize: 7.5 } : { text: 'Pague en la administración o por los medios autorizados por el conjunto.', fontSize: 7.5, color: MUTED },
                data.billing.note ? { text: data.billing.note, fontSize: 7, color: MUTED, margin: [0, 2, 0, 0] } : '',
                { text: `${(data.billing.concepts || ORDER).includes('int') ? `Después de la fecha límite se liquidan intereses de mora (${String(data.billing.interest_rate).replace('.', ',')} % mensual). ` : ''}Si ya pagó, omita esta cuenta.`, fontSize: 6.5, color: MUTED, margin: [0, 2, 0, 0] },
              ],
            },
            label ? { width: 'auto', text: label, fontSize: 7, bold: true, color: ACCENT, alignment: 'right', margin: [8, 0, 0, 0] } : { width: 0, text: '' },
          ],
        },
      ],
    };
  }

  const cutLine = (y) => ({
    absolutePosition: { x: 0, y },
    stack: [
      { canvas: [{ type: 'line', x1: 14, y1: 0, x2: W - 14, y2: 0, dash: { length: 4, space: 3 }, lineWidth: 0.6, lineColor: '#9CA3AF' }] },
      { text: 'cortar aquí', fontSize: 6, color: '#9CA3AF', margin: [W / 2 - 22, 2, 0, 0] },
    ],
  });
  const lower = (b) => ({ absolutePosition: { x: M, y: HALF + M }, stack: [b] });

  async function buildDoc(data, format) {
    const logos = await Promise.all(data.statements.map((st) => dataUrl(st.property?.logo || data.business.logo)));
    const blocks = data.statements.map((st, i) => (label) => block(data, st, label, logos[i]));
    const content = [];
    if (format === 'half') {
      blocks.forEach((b, i) => content.push(i ? { ...b(''), pageBreak: 'before' } : b('')));
      return { pageSize: { width: W, height: HALF }, pageMargins: M, content };
    }
    if (format === 'letter_copy') {
      blocks.forEach((b, i) => {
        content.push(i ? { ...b('ORIGINAL · PROPIETARIO'), pageBreak: 'before' } : b('ORIGINAL · PROPIETARIO'));
        content.push(lower(b('COPIA · ADMINISTRACIÓN')), cutLine(HALF));
      });
    } else {
      for (let i = 0; i < blocks.length; i += 2) {
        content.push(i ? { ...blocks[i](''), pageBreak: 'before' } : blocks[i](''));
        if (blocks[i + 1]) content.push(lower(blocks[i + 1]('')));
        content.push(cutLine(HALF));
      }
    }
    return { pageSize: 'LETTER', pageMargins: [M, M, M, M], content };
  }

  async function create({ unit, property, all = false, format } = {}) {
    const [data] = await Promise.all([App.api('/statements' + App.qs({ unit, property, all: all ? 1 : '' }, { withProperty: false })), App.loadPdf()]);
    if (!data.statements.length) throw new Error('No hay unidades con saldo para generar cuentas de cobro');
    const doc = await buildDoc(data, format || data.billing.format);
    doc.info = { title: `Cuenta de cobro ${data.statements.length === 1 ? data.statements[0].unit.label : data.statements[0].property?.name || ''} ${data.period}` };
    doc.defaultStyle = { font: 'Roboto', fontSize: 8, color: INK };
    doc.styles = { th: { bold: true, fontSize: 7, color: MUTED } };
    return { pdf: pdfMake.createPdf(doc), count: data.statements.length, title: doc.info.title };
  }

  // PDF como Blob (para adjuntar o descargar).
  async function blob(opts) {
    const { pdf } = await create(opts);
    return new Promise((res) => pdf.getBlob(res));
  }

  // Abre el PDF en una pestaña nueva (se abre antes de esperar para que el navegador no la bloquee).
  async function open(opts = {}) {
    const win = window.open('', '_blank');
    if (win) win.document.write('<p style="font-family:system-ui;padding:2rem;color:#5B6B66">Generando cuenta de cobro…</p>');
    try {
      const { pdf, count, title } = await create(opts);
      if (win) pdf.open({}, win); else pdf.download(`${title}.pdf`);
      return count;
    } catch (err) {
      win?.close();
      App.fail(err);
      return 0;
    }
  }

  return { open, blob };
})();

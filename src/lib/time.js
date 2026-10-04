// Fechas "de pared" en la zona horaria del negocio (las citas se guardan así).

export function localNow(timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, datetime: `${date}T${parts.hour}:${parts.minute}` };
}

export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Fecha de hoy en Colombia ('YYYY-MM-DD'); la cartera vence con esta fecha.
export const today = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

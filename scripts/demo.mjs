// Genera scripts/demo.sql: administración de prueba con usuario, conjuntos y datos de ejemplo.
//   node scripts/demo.mjs <correo> <contraseña> > scripts/demo.sql
//   npx wrangler d1 execute cdresidentes --remote --file=scripts/demo.sql
// Correr solo si el correo y el slug demo-residentes no existen (el SQL falla por UNIQUE si ya están).
import { webcrypto as crypto } from 'node:crypto';

const [email = 'tester@example.com', password = 'tester123'] = process.argv.slice(2);
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const uuid = () => crypto.randomUUID();
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// Mismo esquema que src/lib/auth.js: PBKDF2-SHA256, 100 000 iteraciones, salt de 16 bytes.
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
const hash = hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));

const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const month = (n) => { const d = new Date(today.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };

const out = [];
const ins = (table, row) => {
  const cols = Object.keys(row);
  out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => q(row[c])).join(', ')});`);
};

const bid = uuid();
const uid = uuid();
ins('users', { id: uid, email, name: 'Tester Diwilo', pin_hash: hash, pin_salt: hex(salt) });
ins('businesses', { id: bid, name: 'Administración Demo Diwilo', slug: 'demo-residentes', email, phone: '+57 305 385 0193', paid_until: null });
ins('memberships', { user_id: uid, business_id: bid, role: 'owner' });

const OWNERS = ['Beatriz Helena Sánchez', 'Carlos Andrés Mendoza', 'Luisa Fernanda Ríos', 'Jorge Iván Restrepo', 'María Camila Ospina', 'Andrés Felipe Gómez',
  'Natalia Vargas Duque', 'Santiago Herrera', 'Paola Andrea Castro', 'Juan David Londoño', 'Valentina Muñoz', 'Ricardo Salazar', 'Diana Marcela Rojas',
  'Felipe Arango', 'Catalina Mejía', 'Hernán Zapata', 'Laura Cristina Pérez', 'Óscar Iván Torres', 'Daniela Quintero', 'Mauricio Cárdenas',
  'Sandra Milena López', 'Camilo Echeverri', 'Gloria Inés Patiño', 'Sebastián Giraldo', 'Ana María Velásquez', 'Julián Correa', 'Marcela Betancur', 'Esteban Cifuentes'];
const TENANTS = ['Elena Martínez', 'Pedro Pablo Ruiz', 'Sofía Jaramillo', 'Miguel Ángel Ortiz', 'Isabela Franco', 'Tomás Agudelo'];
let ownerIx = 0, tenantIx = 0, phoneN = 3001110000;

const PROPS = [
  { name: 'Conjunto Altos de la Colina', nit: '900.456.789-1', city: 'Bogotá', address: 'Cra. 7 # 150-20', towers: ['Torre A', 'Torre B', 'Torre C'], floors: [3, 4], budget: 28000000 },
  { name: 'Edificio Mirador del Parque', nit: '901.234.567-8', city: 'Medellín', address: 'Cl. 10 # 43-15, El Poblado', towers: [null], floors: [8], budget: 16000000, perFloor: 1, ph: true },
  { name: 'Torres de San Telmo', nit: '900.987.654-3', city: 'Cali', address: 'Av. 6N # 28-40', towers: ['Torre 1', 'Torre 2'], floors: [4], budget: 19000000, local: true },
];

const unitsByProp = {};
for (const p of PROPS) {
  const pid = uuid();
  p.id = pid;
  ins('properties', { id: pid, business_id: bid, name: p.name, nit: p.nit, address: p.address, city: p.city, phone: '601 555 ' + (1000 + ownerIx),
    email: `admin.${p.city.toLowerCase().replace(/[^a-z]/g, '')}@example.com`, towers: p.towers.filter(Boolean).join(', ') || null });
  const units = [];
  for (const tower of p.towers) {
    const floors = p.floors[p.towers.indexOf(tower)] || p.floors[0];
    for (let f = 1; f <= floors; f++) {
      for (let a = 1; a <= (p.perFloor || 2); a++) {
        const number = p.perFloor ? `${f}01` : `${f}0${a}`;
        const kind = p.ph && f === floors ? 'penthouse' : p.local && f === 1 && a === 1 && tower === p.towers[0] ? 'local' : 'apartamento';
        const area = kind === 'penthouse' ? 180 : kind === 'local' ? 60 : 70 + ((f * 7 + a * 5) % 30);
        const hasTenant = (units.length + p.name.length) % 4 === 0;
        const vacant = !hasTenant && (units.length + 3) % 9 === 0;
        units.push({ id: uuid(), business_id: bid, property_id: pid, tower, number, kind, area_m2: area,
          owner_name: OWNERS[ownerIx++ % OWNERS.length], owner_doc: String(10000000 + ownerIx * 7919), owner_phone: String(phoneN++),
          owner_email: `propietario${ownerIx}@example.com`,
          tenant_name: hasTenant ? TENANTS[tenantIx % TENANTS.length] : null, tenant_phone: hasTenant ? String(3201110000 + tenantIx++) : null,
          occupancy: hasTenant ? 'tenant' : vacant ? 'vacant' : 'owner', residents: vacant ? 0 : 1 + ((units.length * 3) % 4),
          vehicles: units.length % 3 === 0 ? `ABC${100 + units.length}` : null });
      }
    }
  }
  const total = units.reduce((s, u) => s + u.area_m2, 0);
  for (const u of units) { u.coefficient = Math.round((u.area_m2 / total) * 1e6) / 1e4; ins('units', u); }
  unitsByProp[pid] = units;

  // Cartera: cuotas de los últimos 4 meses; algunas unidades atrasadas.
  units.forEach((u, i) => {
    const late = i % 5 === 1 ? 3 : i % 5 === 3 ? 1 : i % 7 === 2 ? 2 : 0; // meses sin pagar
    for (let m = -3; m <= 0; m++) {
      const period = month(m);
      const due = `${period}-10`;
      const amount = Math.round((p.budget * u.coefficient) / 100 / 100) * 100;
      // Los últimos `late` meses quedan sin pagar; la cuota del mes en curso, aún sin vencer, la pagaron la mitad.
      const unpaid = -m < late || (m === 0 && due >= today && i % 2 === 0);
      const paid = !unpaid ? addDays(due, -((i % 6) + 1)) : null;
      ins('charges', { id: uuid(), business_id: bid, unit_id: u.id, concept: 'admin', period, description: `Cuota de administración ${period}`, amount, due_date: due, paid_at: paid && paid <= today ? paid : null, payment_ref: paid ? 'PSE' : null });
    }
    if (u.vehicles) ins('charges', { id: uuid(), business_id: bid, unit_id: u.id, concept: 'parking', period: month(0), description: 'Parqueadero cubierto', amount: 90000, due_date: `${month(0)}-10`, paid_at: null, payment_ref: null });
    if (i % 5 === 1) {
      ins('charges', { id: uuid(), business_id: bid, unit_id: u.id, concept: 'ext', period: month(-2), description: 'Cuota extraordinaria impermeabilización de fachada', amount: 850000, due_date: `${month(-2)}-15`, paid_at: null, payment_ref: null });
      ins('charges', { id: uuid(), business_id: bid, unit_id: u.id, concept: 'int', period: month(-1), description: 'Intereses 2% ' + month(-1), amount: 42000, due_date: `${month(-1)}-28`, paid_at: null, payment_ref: null });
    }
    if (i === 6) ins('charges', { id: uuid(), business_id: bid, unit_id: u.id, concept: 'jur', period: month(-1), description: 'Honorarios cobro jurídico', amount: 350000, due_date: `${month(-1)}-20`, paid_at: null, payment_ref: null });
  });

  // Zonas comunes y reservas.
  const zones = [['Salón social', 150000, 'evento', 60], ['Zona BBQ', 40000, 'evento', 20], ['Parqueadero de visitantes', 5000, 'hora', 1]];
  if (p.ph) zones.push(['Gimnasio', 0, 'hora', 10]);
  zones.forEach(([name, fee, unit, cap], zi) => {
    const aid = uuid();
    ins('amenities', { id: aid, business_id: bid, property_id: pid, name, fee, fee_unit: unit, capacity: cap, rules: 'Reservar con 48 horas de anticipación. Entregar limpio. Música hasta las 10 p. m.', active: 1 });
    for (let k = 0; k < 2; k++) {
      const u = units[(zi * 3 + k * 5) % units.length];
      const st = k === 0 ? 'approved' : 'pending';
      ins('bookings', { id: uuid(), business_id: bid, amenity_id: aid, unit_id: u.id, date: addDays(today, 2 + zi * 4 + k * 9), start_time: unit === 'hora' ? '18:00' : '14:00',
        end_time: unit === 'hora' ? '21:00' : '20:00', holder: u.owner_name, amount: unit === 'hora' ? fee * 3 : fee, paid: k === 0 ? 1 : 0, status: st, notes: null });
    }
  });

  // Portería.
  const reqs = [['mudanza', 'Mudanza de entrada', 'Camión placa TRK-582, 3 auxiliares', 3, 'pending'], ['visita', 'Visita técnica de gas', 'Vanti, técnico Luis Pardo', 0, 'approved'],
    ['mantenimiento', 'Revisión de ascensor', 'Mantenimiento preventivo mensual', 1, 'approved'], ['domicilio', 'Paquete retenido en portería', 'Caja grande de Mercado Libre', 0, 'pending'],
    ['alarma', 'Alarma de puerta vehicular', 'Se activó a las 2:14 a. m., sin novedad', -1, 'done'], ['mudanza', 'Trasteo de salida fin de semana', 'Sábado en la mañana', 5, 'pending']];
  reqs.forEach(([kind, title, detail, d, status], k) => ins('requests', { id: uuid(), business_id: bid, property_id: pid, unit_id: units[(k * 4 + 1) % units.length].id, kind, title, detail,
    scheduled_at: `${addDays(today, d)}T${String(8 + k).padStart(2, '0')}:00`, status, resolution: status === 'done' ? 'Revisado por vigilancia' : null }));

  // PQRS.
  const pq = [['queja', 'ruido', 'Ruido después de las 10 p. m. en el piso superior', 'alta', 'open'], ['reclamo', 'parqueadero', 'Vehículo ajeno parqueado en mi celda', 'normal', 'in_progress'],
    ['queja', 'mascotas', 'Perro sin traílla en zonas comunes', 'normal', 'open'], ['peticion', 'mantenimiento', 'Cambio de bombillos en escaleras', 'baja', 'closed'],
    ['sugerencia', 'convivencia', 'Instalar bicicletero en el sótano', 'baja', 'open']];
  pq.forEach(([kind, category, subject, priority, status], k) => {
    const created = `${addDays(today, -(k * 4 + 2))} 1${k}:00:00`;
    ins('pqrs', { id: uuid(), business_id: bid, property_id: pid, unit_id: units[(k * 3 + 2) % units.length].id, kind, category, subject, detail: `${subject}. Reportado por residente.`,
      reporter: units[(k * 3 + 2) % units.length].owner_name, priority, status, response: status === 'closed' ? 'Se atendió la solicitud.' : null,
      closed_at: status === 'closed' ? `${addDays(today, -(k * 4))} 09:00:00` : null, created_at: created });
  });

  // Mascotas.
  const pets = [['Toby', 'perro', 'Labrador', 0, 200], ['Luna', 'gato', 'Criollo', 0, 90], ['Rocky', 'perro', 'Pitbull', 1, -20], ['Coco', 'perro', 'French poodle', 0, 30], ['Kiwi', 'ave', 'Periquito', 0, null]];
  pets.forEach(([name, species, breed, ppp, vax], k) => ins('pets', { id: uuid(), business_id: bid, unit_id: units[(k * 5 + 3) % units.length].id, name, species, breed,
    potentially_dangerous: ppp, vaccinated_until: vax === null ? null : addDays(today, vax), notes: null }));
}

// Comunicados (uno general y uno por conjunto).
ins('notices', { id: uuid(), business_id: bid, property_id: null, title: 'Convocatoria a asamblea general ordinaria', category: 'asamblea', status: 'published', created_by: uid,
  body: 'Estimados copropietarios:\n\nSe convoca a la Asamblea General Ordinaria el último sábado del mes a las 9:00 a. m. en el salón social.\n\nOrden del día:\n1. Verificación del quórum.\n2. Informe de gestión.\n3. Estados financieros y presupuesto.\n4. Proposiciones y varios.\n\nLa Administración' });
PROPS.forEach((p, k) => ins('notices', { id: uuid(), business_id: bid, property_id: p.id, created_by: uid, status: 'published',
  title: ['Fumigación de zonas comunes', 'Corte programado de agua', 'Recordatorio de pago de administración'][k],
  category: ['mantenimiento', 'servicios', 'finanzas'][k],
  body: ['El próximo sábado de 8:00 a. m. a 12:00 m. se fumigarán las zonas comunes. Por favor mantengan las mascotas dentro de los apartamentos.',
    'La empresa de acueducto suspenderá el servicio el jueves de 9:00 a. m. a 3:00 p. m. Recomendamos almacenar agua.',
    'Recordamos que la cuota de administración vence el día 10 de cada mes. Evite intereses de mora pagando a tiempo por PSE.'][k] }));

console.log(`-- Datos de prueba generados por scripts/demo.mjs (${today}). Usuario: ${email}\n` + out.join('\n'));

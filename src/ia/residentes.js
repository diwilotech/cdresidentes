// Herramientas de IA hechas a mano: el resumen en vivo de la administración (lo que antes alimentaba el chat «Diwilo AI»).
import { contextFor } from '../api/ai.js';
import { getRow } from '../lib/crud.js';

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

export default [
  {
    name: 'conjuntos.resumen_en_vivo', modulo: 'conjuntos', rol: 'staff', tipo: 'lectura',
    description: 'Resumen en vivo de la administración o de un conjunto: unidades y habitantes, cartera vencida y recaudo del mes, las unidades con mayor deuda, PQRS abiertas, solicitudes de portería, próximas reservas, mascotas sin vacunas y últimos comunicados. Empieza por aquí para cualquier pregunta general.',
    inputSchema: S({ conjunto_id: { type: 'string', description: 'Id del conjunto (si falta, resume todos)' } }),
    run: async (c, a) => {
      if (a.conjunto_id) await getRow(c, 'properties', String(a.conjunto_id), 'Conjunto');
      return { resumen: await contextFor(c, a.conjunto_id ? String(a.conjunto_id) : '') };
    },
  },
];

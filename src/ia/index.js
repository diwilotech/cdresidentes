// Herramientas de IA de los módulos propios de Residentes (a mano en residentes.js, declarativas en control.js). Las de los módulos centrales (Finanzas,
// Marketing…) llegan de Diwilo Modulos (src/lib/central.js → centralTools) y mcp.js las une.
import residentes from './residentes.js';
import control from './control.js';

export const TOOLS = [...residentes, ...control];

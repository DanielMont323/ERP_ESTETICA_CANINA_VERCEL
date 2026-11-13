// Texto para mostrar valores internos (estados, tipos, categorías) con mayúscula y acentos.
// Antes se mostraban tal cual se guardan: "credito", "pendiente", "nomina".
const ETIQUETAS = {
  credito: 'Crédito',
  contado: 'Contado',
  pendiente: 'Pendiente',
  pagada: 'Pagada',
  pagado: 'Pagado',
  cancelada: 'Cancelada',
  cancelado: 'Cancelado',
  vencida: 'Vencida',
  vencido: 'Vencido',
  completada: 'Completada',
  modificando: 'En modificación',
  fijo: 'Fijo',
  variable: 'Variable',
  renta: 'Renta',
  servicios: 'Servicios',
  nomina: 'Nómina',
  materiales: 'Materiales',
  marketing: 'Marketing',
  mantenimiento: 'Mantenimiento',
  impuestos: 'Impuestos',
  otros: 'Otros'
};

export const etiqueta = valor => {
  if (valor === undefined || valor === null || valor === '') return '';
  const clave = String(valor).toLowerCase();
  if (ETIQUETAS[clave]) return ETIQUETAS[clave];
  const s = String(valor);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

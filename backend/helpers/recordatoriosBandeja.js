/**
 * Bandeja de recordatorios: une los recordatorios manuales (colección recordatorios) con los
 * recordatorios de próxima dosis que salen del carnet (vacunas y desparasitantes).
 *
 * ESTADOS (se calculan al consultar; NUNCA se guardan ni cambian solos):
 *   - 'retrasado'  : pendiente y su día ya pasó
 *   - 'hoy'        : pendiente y es del día de hoy (Tepic)
 *   - 'pendiente'  : pendiente con fecha futura
 *   - 'completado' : marcado como completado (o, en el carnet, atendido / ya se aplicó la siguiente dosis)
 *
 * FECHAS: convención del sistema "hora de Tepic guardada como UTC". El día de un recordatorio
 * es la parte AAAA-MM-DD de su fecha en UTC (igual que formatCalendarDate en el frontend),
 * y el "hoy" es el día actual en Tepic (UTC-7, sin horario de verano).
 */
const Recordatorio = require('../models/Recordatorio');
const CarnetVacunacion = require('../models/CarnetVacunacion');

const OFFSET_TEPIC_MS = 7 * 3600000;

const diaDe = (fecha) => (fecha ? new Date(fecha).toISOString().slice(0, 10) : null);
const hoyTepic = (ahora = new Date()) => new Date(ahora.getTime() - OFFSET_TEPIC_MS).toISOString().slice(0, 10);

function estadoPorFecha(fecha, ahora = new Date()) {
  const dia = diaDe(fecha);
  const hoy = hoyTepic(ahora);
  if (dia < hoy) return 'retrasado';
  if (dia === hoy) return 'hoy';
  return 'pendiente';
}

const ORDEN_ESTADO = { retrasado: 0, hoy: 1, pendiente: 2, completado: 3 };

const quien = (u) => ({ usuario: u._id, nombre: u.name });

function deManual(r, ahora) {
  const completado = r.status === 'completado';
  return {
    id: `manual-${r._id}`,
    origen: 'manual',
    recordatorioId: r._id,
    tipo: r.type,
    titulo: r.title,
    descripcion: r.description || '',
    fecha: r.date,
    dia: diaDe(r.date),
    prioridad: r.priority,
    status: r.status,
    estado: completado ? 'completado' : estadoPorFecha(r.date, ahora),
    completado: completado ? { fecha: r.completedAt || null, ...(r.completadoPor || {}) } : null,
    duenoNotificado: r.duenoNotificado?.fecha ? r.duenoNotificado : null,
    puedeNotificarDueno: r.type === 'vacuna',
    cuentaPorPagar: r.cuentaPorPagar || null,
    creadoPor: r.user?.name || null
  };
}

function deCarnet(carnet, ap, siguiente, ahora) {
  const nombreProducto = ap.nombre || ap.vacuna?.name || (typeof ap.vacuna === 'string' ? ap.vacuna : null) || (ap.tipo === 'desparasitante' ? 'Desparasitante' : 'Vacuna');
  const atendido = ap.atendido?.fecha ? ap.atendido : null;
  let completado = null;
  if (atendido) completado = { fecha: atendido.fecha, usuario: atendido.usuario, nombre: atendido.nombre, motivo: 'manual' };
  else if (siguiente) completado = { fecha: siguiente.fecha, motivo: 'siguiente_dosis_aplicada' };
  const mascota = carnet.mascota && typeof carnet.mascota === 'object' ? carnet.mascota : null;
  const dueno = carnet.propietario && typeof carnet.propietario === 'object' ? carnet.propietario : null;
  return {
    id: `carnet-${carnet._id}-${ap._id}`,
    origen: 'carnet',
    carnetId: carnet._id,
    aplicacionId: ap._id,
    tipo: ap.tipo === 'desparasitante' ? 'desparasitante' : 'vacuna',
    titulo: `${ap.tipo === 'desparasitante' ? 'Desparasitación' : 'Vacuna'}: ${nombreProducto}`,
    descripcion: `Mascota: ${mascota?.name || carnet.nombreMascota} · Dueño: ${dueno?.name || carnet.nombrePropietario}`,
    fecha: ap.proximaDosis,
    dia: diaDe(ap.proximaDosis),
    prioridad: 'media',
    status: completado ? 'completado' : 'pendiente',
    estado: completado ? 'completado' : estadoPorFecha(ap.proximaDosis, ahora),
    completado,
    duenoNotificado: ap.duenoNotificado?.fecha ? ap.duenoNotificado : null,
    puedeNotificarDueno: true,
    mascota: { id: mascota?._id || null, nombre: mascota?.name || carnet.nombreMascota },
    dueno: { id: dueno?._id || null, nombre: dueno?.name || carnet.nombrePropietario, telefono: dueno?.phone || null },
    aplicadaEl: ap.fecha,
    // Para proponer la siguiente dosis al registrar "se aplicó aquí"
    diasSugeridos: ap.diasProximaDosis || (ap.fecha && ap.proximaDosis ? Math.max(0, Math.round((new Date(ap.proximaDosis) - new Date(ap.fecha)) / 86400000)) : null)
  };
}

// La "siguiente dosis" de una aplicación: otra aplicación posterior del mismo producto en el mismo carnet.
function siguienteAplicacion(aplicaciones, ap) {
  const clave = String(ap.vacuna?._id || ap.vacuna);
  return aplicaciones
    .filter(o => o !== ap && !o.replacedBy && String(o.vacuna?._id || o.vacuna) === clave && new Date(o.fecha) > new Date(ap.fecha))
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))[0] || null;
}

/**
 * @param {'pendientes'|'completados'|'todos'} vista
 */
async function construirBandeja({ vista = 'pendientes', ahora = new Date() } = {}) {
  const filtroManual = vista === 'pendientes' ? { status: 'pendiente' }
    : vista === 'completados' ? { status: 'completado' }
      : { status: { $in: ['pendiente', 'completado'] } };
  const manuales = await Recordatorio.find(filtroManual).populate('user', 'name').lean();

  const carnets = await CarnetVacunacion.find({ 'vacunas.proximaDosis': { $ne: null } })
    .populate('mascota', 'name')
    .populate('propietario', 'name phone')
    .lean();
  // vacunas.vacuna es Mixed (ObjectId o texto histórico): se resuelve el nombre aparte para no romper con textos
  const Vacuna = require('../models/Vacuna');
  const ids = [...new Set(carnets.flatMap(c => c.vacunas.map(v => v.vacuna)).filter(v => v && typeof v === 'object').map(String))];
  const catalogo = new Map((await Vacuna.find({ _id: { $in: ids } }).select('name').lean()).map(v => [String(v._id), v]));

  const deCarnets = [];
  for (const c of carnets) {
    const aplicaciones = c.vacunas.map(v => ({ ...v, vacuna: catalogo.get(String(v.vacuna)) || v.vacuna }));
    for (const ap of aplicaciones) {
      if (!ap.proximaDosis || ap.replacedBy) continue;
      const item = deCarnet(c, ap, siguienteAplicacion(aplicaciones, ap), ahora);
      if (vista === 'pendientes' && item.status !== 'pendiente') continue;
      if (vista === 'completados' && item.status !== 'completado') continue;
      deCarnets.push(item);
    }
  }

  const items = [...manuales.map(r => deManual(r, ahora)), ...deCarnets];
  items.sort((a, b) => {
    if (a.estado === 'completado' && b.estado === 'completado') {
      return new Date(b.completado?.fecha || b.fecha) - new Date(a.completado?.fecha || a.fecha);
    }
    return (ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado]) || (new Date(a.fecha) - new Date(b.fecha));
  });

  const conteo = { retrasado: 0, hoy: 0, pendiente: 0, completado: 0 };
  items.forEach(i => { conteo[i.estado] += 1; });
  // Cuentas por pagar que ya tienen recordatorio de pago ligado (en cualquier estado): la campana no las
  // repite, así completar el recordatorio también apaga su alerta aunque la cuenta siga abierta.
  const cuentasConRecordatorio = (await Recordatorio.distinct('cuentaPorPagar', { cuentaPorPagar: { $ne: null } })).map(String);
  return { items, conteo, hoy: hoyTepic(ahora), cuentasConRecordatorio };
}

module.exports = { construirBandeja, estadoPorFecha, hoyTepic, diaDe, quien };

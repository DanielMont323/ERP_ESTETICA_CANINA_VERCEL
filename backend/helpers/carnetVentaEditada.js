/**
 * Carnet al EDITAR una venta (vacunas y desparasitantes).
 *
 * Reglas (autorizado 2026-11-20):
 *  - Solo se tocan las aplicaciones del carnet que creó ESA venta (vacunas[].venta = venta._id).
 *  - Si se capturaron "días para próxima dosis", se corrige la próxima dosis de esas aplicaciones.
 *    Sin días capturados, la próxima dosis que ya tenían NO se toca.
 *  - Si falta una aplicación (más piezas, otra mascota, o la venta no la registró), se agrega.
 *  - Nunca se borra nada: si sobran aplicaciones de la venta (se quitó una pieza o cambió la mascota),
 *    se quedan como estaban.
 */
const Producto = require('../models/Producto');
const CategoriaProducto = require('../models/CategoriaProducto');
const Mascota = require('../models/Mascota');
const Cliente = require('../models/Cliente');
const CarnetVacunacion = require('../models/CarnetVacunacion');

const DIA_MS = 86400000;
const diaDe = (f) => (f ? new Date(f).toISOString().slice(0, 10) : null);

const errorHttp = (status, message) => Object.assign(new Error(message), { httpStatus: status });

async function tipoDeProducto(producto, session) {
  let nombre = '';
  const cat = producto?.category;
  if (cat && typeof cat === 'object' && cat.name) nombre = cat.name;
  else if (cat && /^[0-9a-f]{24}$/i.test(String(cat))) {
    const doc = await CategoriaProducto.findById(String(cat)).select('name').session(session || null).lean();
    nombre = doc?.name || '';
  } else if (typeof cat === 'string') nombre = cat;
  const n = nombre.toLowerCase();
  if (n === 'vacunas' || n === 'vacuna') return 'vacuna';
  if (n === 'desparasitantes' || n === 'desparasitante' || n.includes('desparasitante')) return 'desparasitante';
  return null;
}

/**
 * Antes de guardar la venta: valida mascotas y recalcula la próxima dosis de cada aplicación
 * cuando hay días capturados (modifica items para que la venta guarde lo mismo que el carnet).
 * Devuelve las unidades a reflejar en el carnet.
 */
async function prepararDosisVenta({ items, fechaVenta, customer, session }) {
  const unidades = [];
  for (const item of items || []) {
    if (item.type !== 'producto') continue;
    const producto = await Producto.findById(item.item).select('name category').session(session || null).lean();
    if (!producto) continue;
    const tipo = await tipoDeProducto(producto, session);
    if (!tipo) continue;

    const dias = item.diasProximaDosis === '' || item.diasProximaDosis == null ? null : Number(item.diasProximaDosis);
    if (dias !== null && (!Number.isInteger(dias) || dias < 0 || dias > 3650)) {
      throw errorHttp(400, `Días para próxima dosis inválidos en "${producto.name}"`);
    }

    let aplicaciones = Array.isArray(item.aplicaciones) && item.aplicaciones.length ? item.aplicaciones : null;
    if (!aplicaciones && item.mascota) {
      aplicaciones = Array.from({ length: Number(item.quantity) || 1 }, () => ({ mascota: item.mascota }));
    }
    if (!aplicaciones) continue; // venta antigua sin mascota: no hay a quién registrarle la dosis

    for (const ap of aplicaciones) {
      if (!ap.mascota) throw errorHttp(400, `Selecciona la mascota de cada unidad de "${producto.name}"`);
      if (!customer) throw errorHttp(400, 'Para vender vacunas o desparasitantes debe seleccionar un cliente');
      const mascota = await Mascota.findById(ap.mascota).select('owner').session(session || null).lean();
      if (!mascota) throw errorHttp(404, 'Mascota no encontrada');
      if (!mascota.owner || String(mascota.owner) !== String(customer)) {
        throw errorHttp(403, 'La mascota no pertenece al cliente seleccionado');
      }
      // Los días se cuentan desde la fecha de la venta (lo mismo que muestra la pantalla de edición)
      const base = ap.fechaAplicacion ? new Date(ap.fechaAplicacion) : new Date(fechaVenta);
      if (dias > 0) ap.proximaDosis = new Date(new Date(fechaVenta).getTime() + dias * DIA_MS);
      else if (dias === 0) ap.proximaDosis = null;
      unidades.push({
        producto: producto._id,
        nombre: producto.name,
        tipo,
        mascota: String(ap.mascota),
        fecha: base,
        proximaDosis: ap.proximaDosis || null,
        dias,
        diasCapturados: dias !== null
      });
    }
  }
  return unidades;
}

/** Después de guardar la venta (misma transacción): corrige o agrega aplicaciones en el carnet. */
async function sincronizarCarnetVenta({ venta, unidades, customer, session }) {
  const resultado = { actualizadas: 0, agregadas: 0, sinCambio: 0, sobrantes: 0 };
  const carnets = await CarnetVacunacion.find({ 'vacunas.venta': venta._id }).session(session || null);
  const porMascota = new Map(carnets.map(c => [String(c.mascota), c]));

  // Aplicaciones existentes de ESTA venta, agrupadas por producto + mascota
  const existentes = new Map();
  for (const c of carnets) {
    for (const v of c.vacunas) {
      if (!v.venta || String(v.venta) !== String(venta._id) || v.replacedBy) continue;
      const k = `${String(v.vacuna)}|${String(c.mascota)}`;
      if (!existentes.has(k)) existentes.set(k, []);
      existentes.get(k).push(v);
    }
  }

  const tocados = new Set();
  let cliente = null;
  for (const u of unidades) {
    const k = `${String(u.producto)}|${u.mascota}`;
    const lista = existentes.get(k) || [];
    const ap = lista.shift();
    if (ap) {
      if (u.diasCapturados && diaDe(ap.proximaDosis) !== diaDe(u.proximaDosis)) {
        ap.proximaDosis = u.proximaDosis;
        ap.diasProximaDosis = u.dias || undefined;
        tocados.add(String(ap.ownerDocument()._id));
        resultado.actualizadas += 1;
      } else {
        resultado.sinCambio += 1;
      }
      continue;
    }
    // Falta en el carnet: se agrega
    let carnet = porMascota.get(u.mascota) || await CarnetVacunacion.findOne({ mascota: u.mascota }).session(session || null);
    if (!carnet) {
      const mascota = await Mascota.findById(u.mascota).session(session || null).lean();
      cliente = cliente || await Cliente.findById(customer).session(session || null).lean();
      carnet = new CarnetVacunacion({
        mascota: u.mascota,
        nombreMascota: mascota.name,
        especie: mascota.type,
        raza: mascota.breed,
        propietario: customer,
        nombrePropietario: cliente?.name,
        vacunas: []
      });
    }
    porMascota.set(u.mascota, carnet);
    carnet.vacunas.push({
      vacuna: u.producto,
      nombre: u.nombre,
      tipo: u.tipo,
      fecha: u.fecha,
      proximaDosis: u.proximaDosis,
      diasProximaDosis: u.dias || undefined,
      venta: venta._id
    });
    tocados.add(String(carnet._id));
    resultado.agregadas += 1;
  }
  existentes.forEach(lista => { resultado.sobrantes += lista.length; });

  for (const c of porMascota.values()) {
    if (tocados.has(String(c._id))) await c.save({ session });
  }
  return resultado;
}

module.exports = { prepararDosisVenta, sincronizarCarnetVenta, tipoDeProducto };

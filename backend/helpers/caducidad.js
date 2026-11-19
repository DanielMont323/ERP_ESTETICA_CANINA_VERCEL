/**
 * Caducidad capturada en las compras.
 * - Cada producto de una compra puede llevar su fecha de caducidad (Compra.items[].expirationDate),
 *   que se copia a su capa FIFO (InventoryLayer.expirationDate, campo que ya existía).
 * - La caducidad que se ve en Productos (Producto.expirationDate) pasa a ser la MÁS PRÓXIMA de los lotes
 *   que todavía tienen piezas. Si ningún lote con piezas trae caducidad, no se toca lo que ya tenía.
 * Fechas de calendario: se guardan al mediodía UTC (convención del sistema).
 */
const InventoryLayer = require('../models/InventoryLayer');
const Producto = require('../models/Producto');

/** 'AAAA-MM-DD' (o Date) → Date al mediodía UTC; vacío → undefined. Lanza si no es válida. */
function fechaCaducidad(valor) {
  if (valor === undefined || valor === null || valor === '') return undefined;
  const texto = valor instanceof Date ? valor.toISOString().slice(0, 10) : String(valor).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) throw new Error('Fecha de caducidad inválida');
  const d = new Date(`${texto}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error('Fecha de caducidad inválida');
  return d;
}

async function actualizarCaducidadProducto(productoId, session) {
  const lote = await InventoryLayer.findOne({
    producto: productoId, isActive: true, remainingQuantity: { $gt: 0 }, expirationDate: { $ne: null }
  }).sort({ expirationDate: 1 }).select('expirationDate').session(session || null).lean();
  if (!lote) return;
  await Producto.updateOne({ _id: productoId }, { $set: { expirationDate: lote.expirationDate } }, { session });
}

module.exports = { fechaCaducidad, actualizarCaducidadProducto };

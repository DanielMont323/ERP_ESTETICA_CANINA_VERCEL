const { v4: uuidv4 } = require('uuid');
const Producto = require('../models/Producto');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const { getCurrentDateGMT7 } = require('./timezone');

/**
 * Devuelve al inventario los productos de una venta ANTERIOR a FIFO (sin fifoTracked) al cancelarla.
 *
 * Esas ventas no registraron de qué capa salió la mercancía, así que no se puede regresar a su
 * capa de origen. Por cada producto:
 *  - Si su stock y sus capas activas cuadran (caso normal tras la apertura FIFO, o stock 0 sin
 *    capas): se crea una capa nueva 'ajuste_entrada' con las piezas devueltas y un movimiento de
 *    entrada (source 'ajuste') ligado a la venta. Stock y capas suben juntos.
 *    Costo (estimado): el de la capa de apertura del producto; si no tiene, Producto.cost;
 *    si tampoco, $0 marcado 'sin_costo'.
 *  - Si tiene stock pero ninguna capa (antes de la apertura FIFO): comportamiento original,
 *    solo se suma al stock; la apertura lo incluirá después.
 *  - Si tiene capas que no cuadran con el stock: error 409 (inconsistencia previa; no se toca).
 *
 * @returns {Promise<Array>} detalle por producto (para la respuesta y pruebas)
 */
async function devolverVentaHistorica(venta, userId, session) {
  const detalle = [];
  const fecha = getCurrentDateGMT7();
  for (const [index, item] of venta.items.entries()) {
    if (item.type !== 'producto') continue;
    const producto = await Producto.findById(item.item).session(session);
    if (!producto) continue;

    const capas = await InventoryLayer.find({ producto: producto._id, isActive: true }).session(session);
    const sumaCapas = capas.reduce((s, c) => s + c.remainingQuantity, 0);
    const cuadra = Math.abs(sumaCapas - producto.stock) < 1e-6;

    if (!capas.length && producto.stock > 0) {
      producto.stock += item.quantity;
      await producto.save({ session });
      detalle.push({ producto: producto._id, cantidad: item.quantity, modo: 'stock_sin_fifo' });
      continue;
    }
    if (!cuadra) {
      const e = new Error(`El inventario de "${producto.name}" no cuadra (stock ${producto.stock}, capas ${sumaCapas}). Revise el inventario antes de cancelar.`);
      e.httpStatus = 409;
      throw e;
    }

    const apertura = await InventoryLayer.findOne({ producto: producto._id, source: 'inventario_inicial' }).sort({ createdAt: 1 }).session(session);
    let unitCost; let costSource;
    if (apertura) { unitCost = apertura.unitCost; costSource = apertura.costSource || 'costo_capturado'; }
    else if (typeof producto.cost === 'number' && producto.cost > 0) { unitCost = producto.cost; costSource = 'costo_capturado'; }
    else { unitCost = 0; costSource = 'sin_costo'; }
    if (unitCost === 0) costSource = 'sin_costo';
    const totalCost = Math.round(unitCost * item.quantity * 100) / 100;
    const nota = `Devolución por cancelación de venta anterior a FIFO ${venta._id}`;

    const [capa] = await InventoryLayer.create([{
      producto: producto._id,
      quantity: item.quantity,
      initialQuantity: item.quantity,
      remainingQuantity: item.quantity,
      unitCost,
      totalCost,
      costSource,
      source: 'ajuste_entrada',
      isInitialLayer: false,
      receivedDate: fecha,
      notes: nota
    }], { session });
    await InventoryMovement.create([{
      producto: producto._id,
      type: 'entrada',
      quantity: item.quantity,
      unitCost,
      totalCost,
      source: 'ajuste',
      sourceId: venta._id,
      sale: venta._id,
      saleItemIndex: index,
      date: fecha,
      user: userId,
      movementId: uuidv4(),
      reversalReason: 'cancelacion_venta',
      notes: nota
    }], { session });
    producto.stock += item.quantity;
    if (!producto.fifoInitialized) { producto.fifoInitialized = true; producto.fifoInitializationDate = new Date(); }
    await producto.save({ session });
    detalle.push({ producto: producto._id, cantidad: item.quantity, modo: 'capa_ajuste', capa: capa._id, unitCost, costSource });
  }
  return detalle;
}

module.exports = { devolverVentaHistorica };

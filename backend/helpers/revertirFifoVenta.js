const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const Producto = require('../models/Producto');
const { v4: uuidv4 } = require('uuid');

/**
 * Revierte el consumo FIFO de una venta.
 * Restaura cantidades a las capas exactas de origen usando layersConsumed[].
 * NO elimina ni modifica los movimientos originales: crea un movimiento compensatorio
 * por cada movimiento original, con originalMovement apuntando a él.
 *
 * F2: solo se revierten los movimientos de salida que todavía no tienen reversión
 *     (antes se revertían también los de ediciones anteriores → doble devolución).
 * F3: cada reversión referencia su movimiento original.
 *
 * @param {ObjectId} ventaId - ID de la venta
 * @param {String} operationId - ID de la operación (para idempotencia)
 * @param {ObjectId} userId - ID del usuario
 * @param {Object} session - Sesión de MongoDB
 * @param {String} reversalReason - 'edicion_venta' | 'cancelacion_venta'
 * @returns {Promise<Object>} - Resultado de la reversión
 */
async function revertirFIFOEnVenta(ventaId, operationId, userId, session, reversalReason = 'edicion_venta') {
  // 1. Movimientos de salida de la venta (productos e insumos de servicios)
  const salidas = await InventoryMovement.find({
    sale: ventaId,
    type: 'salida'
  }).sort({ _id: 1 }).session(session);

  if (salidas.length === 0) {
    return { success: true, revertidos: 0, message: 'No hay movimientos para revertir' };
  }

  // 2. Excluir los que ya fueron revertidos
  const yaRevertidos = await InventoryMovement.find({
    originalMovement: { $in: salidas.map(m => m._id) }
  }).select('originalMovement').session(session);
  const revertidosSet = new Set(yaRevertidos.map(r => r.originalMovement.toString()));
  const pendientes = salidas.filter(m => !revertidosSet.has(m._id.toString()));

  // 3. Revertir cada movimiento pendiente
  for (const movimiento of pendientes) {
    const cantidad = Math.abs(movimiento.quantity);
    const restaurados = [];

    for (const consumido of movimiento.layersConsumed) {
      const layer = await InventoryLayer.findById(consumido.layer).session(session);
      if (!layer) {
        throw new Error(`Capa con ID ${consumido.layer} no encontrada. Reversión abortada.`);
      }

      if (Math.abs(layer.unitCost - consumido.unitCost) > 0.01) {
        throw new Error(`Discrepancia de unitCost en capa ${layer._id}. Original: ${consumido.unitCost}, Actual: ${layer.unitCost}. Reversión abortada.`);
      }

      const newRemaining = layer.remainingQuantity + consumido.quantityConsumed;

      if (newRemaining > layer.initialQuantity + 1e-9) {
        throw new Error(`Restauración excedería initialQuantity. Layer: ${layer._id}, newRemaining: ${newRemaining}, initialQuantity: ${layer.initialQuantity}. Reversión abortada.`);
      }
      if (newRemaining < 0) {
        throw new Error(`Resultado de remainingQuantity sería negativo. Layer: ${layer._id}, newRemaining: ${newRemaining}. Reversión abortada.`);
      }

      layer.remainingQuantity = newRemaining;
      if (layer.isExhausted && newRemaining > 0) {
        layer.isExhausted = false;
        layer.exhaustedDate = null;
      }
      await layer.save({ session });

      restaurados.push({
        layer: consumido.layer,
        quantityConsumed: consumido.quantityConsumed,
        unitCost: consumido.unitCost,
        cost: consumido.cost
      });
    }

    const producto = await Producto.findById(movimiento.producto).session(session);
    if (!producto) {
      throw new Error(`Producto con ID ${movimiento.producto} no encontrado. Reversión abortada.`);
    }
    producto.stock += cantidad;
    await producto.save({ session });

    const totalCost = restaurados.reduce((sum, l) => sum + l.cost, 0);
    await new InventoryMovement({
      producto: movimiento.producto,
      type: 'entrada',
      quantity: cantidad,
      unitCost: cantidad > 0 ? totalCost / cantidad : 0,
      totalCost,
      layersConsumed: restaurados,
      source: 'reversion_venta',
      sourceId: ventaId,
      sale: ventaId,
      saleItemIndex: movimiento.saleItemIndex,
      service: movimiento.service,
      operationId,
      operationBatchId: operationId,
      originalMovement: movimiento._id,
      reversalReason,
      movementId: uuidv4(),
      date: new Date(),
      user: userId
    }).save({ session });
  }

  return {
    success: true,
    revertidos: pendientes.length,
    message: 'Reversión FIFO completada exitosamente'
  };
}

module.exports = { revertirFIFOEnVenta };

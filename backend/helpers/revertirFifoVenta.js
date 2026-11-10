const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const Producto = require('../models/Producto');
const { v4: uuidv4 } = require('uuid');

/**
 * Función para revertir el consumo FIFO de una venta
 * Restaura cantidades a las capas exactas de origen usando layersConsumed[]
 * NO elimina movimientos originales, crea movimientos compensatorios
 *
 * @param {ObjectId} ventaId - ID de la venta
 * @param {String} operationId - ID de la operación (para idempotencia)
 * @param {ObjectId} userId - ID del usuario
 * @param {Object} session - Sesión de MongoDB
 * @returns {Promise<Object>} - Resultado de la reversión
 */
async function revertirFIFOEnVenta(ventaId, operationId, userId, session) {
  try {
    // 1. Buscar movimientos originales de la venta
    const movimientosOriginales = await InventoryMovement.find({
      sale: ventaId,
      type: 'salida'
    }).session(session);

    if (movimientosOriginales.length === 0) {
      return { success: true, message: 'No hay movimientos para revertir' };
    }

    // 2. Agrupar reversión por producto
    const reversiónPorProducto = {};

    for (const movimiento of movimientosOriginales) {
      const productoId = movimiento.producto;

      if (!reversiónPorProducto[productoId]) {
        reversiónPorProducto[productoId] = {
          totalQuantity: 0,
          layers: []
        };
      }

      reversiónPorProducto[productoId].totalQuantity += Math.abs(movimiento.quantity);

      // Para cada capa en layersConsumed, restaurar cantidad
      for (const layerConsumed of movimiento.layersConsumed) {
        reversiónPorProducto[productoId].layers.push({
          layer: layerConsumed.layer,
          quantity: layerConsumed.quantityConsumed,
          unitCost: layerConsumed.unitCost
        });
      }
    }

    // 3. Restaurar capas
    for (const productoId in reversiónPorProducto) {
      const reversión = reversiónPorProducto[productoId];

      for (const layerInfo of reversión.layers) {
        const layer = await InventoryLayer.findById(layerInfo.layer).session(session);
        if (!layer) {
          throw new Error(`Capa con ID ${layerInfo.layer} no encontrada. Reversión abortada.`);
        }

        // Validar que unitCost coincide
        if (Math.abs(layer.unitCost - layerInfo.unitCost) > 0.01) {
          throw new Error(`Discrepancia de unitCost en capa ${layer._id}. Original: ${layerInfo.unitCost}, Actual: ${layer.unitCost}. Reversión abortada.`);
        }

        const newRemaining = layer.remainingQuantity + layerInfo.quantity;

        // Validar que no exceda initialQuantity
        if (newRemaining > layer.initialQuantity) {
          throw new Error(`Restauración excedería initialQuantity. Layer: ${layer._id}, newRemaining: ${newRemaining}, initialQuantity: ${layer.initialQuantity}. Reversión abortada.`);
        }

        // Validar que no sea negativo
        if (newRemaining < 0) {
          throw new Error(`Resultado de remainingQuantity sería negativo. Layer: ${layer._id}, newRemaining: ${newRemaining}. Reversión abortada.`);
        }

        layer.remainingQuantity = newRemaining;

        // Si estaba agotada y ahora tiene cantidad, desmarcar
        if (layer.isExhausted && newRemaining > 0) {
          layer.isExhausted = false;
          layer.exhaustedDate = null;
        }

        await layer.save({ session });
      }

      // Actualizar stock del producto
      const producto = await Producto.findById(productoId).session(session);
      producto.stock += reversión.totalQuantity;
      await producto.save({ session });

      // Crear movimiento de entrada para la reversión
      const movement = new InventoryMovement({
        producto: productoId,
        type: 'entrada',
        quantity: reversión.totalQuantity,
        unitCost: reversión.layers[0].unitCost,
        totalCost: reversión.layers.reduce((sum, l) => sum + (l.quantity * l.unitCost), 0),
        layersConsumed: reversión.layers.map(l => ({
          layer: l.layer,
          quantityConsumed: l.quantity,
          unitCost: l.unitCost,
          cost: l.quantity * l.unitCost
        })),
        source: 'reversion_venta',
        sourceId: ventaId,
        sale: ventaId,
        operationId: operationId,
        operationBatchId: operationId,
        originalMovement: null, // Se puede relacionar con el movimiento original si se necesita
        reversalReason: 'edicion_venta',
        movementId: uuidv4(),
        date: new Date(),
        user: userId
      });
      await movement.save({ session });
    }

    return {
      success: true,
      message: 'Reversión FIFO completada exitosamente'
    };
  } catch (error) {
    throw error;
  }
}

module.exports = { revertirFIFOEnVenta };

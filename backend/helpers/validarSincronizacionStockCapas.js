const InventoryLayer = require('../models/InventoryLayer');
const Producto = require('../models/Producto');

/**
 * Función para validar sincronización entre producto.stock y capas FIFO activas
 *
 * @param {ObjectId} ventaId - ID de la venta (para identificar productos afectados)
 * @param {Object} session - Sesión de MongoDB
 * @returns {Promise<Object>} - Resultado de la validación
 */
async function validarSincronizacionStockCapas(ventaId, session) {
  try {
    // 1. Buscar movimientos de la venta para identificar productos afectados
    const InventoryMovement = require('../models/InventoryMovement');
    const movimientos = await InventoryMovement.find({ sale: ventaId }).session(session);

    if (movimientos.length === 0) {
      return { success: true, message: 'No hay movimientos para validar' };
    }

    // 2. Obtener productos únicos afectados
    const productosIds = [...new Set(movimientos.map(m => m.producto.toString()))];

    // 3. Validar sincronización para cada producto
    for (const productoId of productosIds) {
      const producto = await Producto.findById(productoId).session(session);
      if (!producto) {
        throw new Error(`Producto con ID ${productoId} no encontrado`);
      }

      const activeLayers = await InventoryLayer.find({
        producto: productoId,
        isActive: true,
        remainingQuantity: { $gt: 0 }
      }).sort({ receivedDate: 1, _id: 1 }).session(session);

      const totalRemaining = activeLayers.reduce((sum, layer) => sum + layer.remainingQuantity, 0);

      // Validación de sincronía: producto.stock debe igualar suma de remainingQuantity de capas activas
      if (Math.abs(producto.stock - totalRemaining) > 0.01) {
        throw new Error(`Inconsistencia detectada para producto ${producto.name}. Stock: ${producto.stock}, Capas: ${totalRemaining}. Contacte al administrador.`);
      }
    }

    return {
      success: true,
      message: 'Sincronización validada exitosamente'
    };
  } catch (error) {
    throw error;
  }
}

module.exports = { validarSincronizacionStockCapas };

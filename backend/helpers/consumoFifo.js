const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const Producto = require('../models/Producto');

// Error de inventario con el estado HTTP que debe recibir el cliente (lo usa la ruta de ventas).
function fifoError(message, httpStatus) {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  return error;
}

/**
 * Función reutilizable para consumo FIFO en ventas
 * Agrupa consumos por producto, valida disponibilidad, consume capas FIFO y crea movimientos
 *
 * @param {Array} items - Items de la venta (productos y servicios)
 * @param {ObjectId} ventaId - ID de la venta
 * @param {Date} ventaDate - Fecha de la venta
 * @param {ObjectId} userId - ID del usuario
 * @param {String} operationId - ID de la operación (para idempotencia)
 * @param {Object} session - Sesión de MongoDB
 * @returns {Promise<Object>} - Resultado del consumo
 */
async function consumirFIFOEnVenta(items, ventaId, ventaDate, userId, operationId, session) {
  try {
    // 1. Agrupar consumos por producto (productos + insumos de servicios)
    const consumosPorProducto = {};
    const detallesPorProducto = {};

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const item = items[itemIndex];

      if (item.type === 'producto') {
        if (!consumosPorProducto[item.item]) {
          consumosPorProducto[item.item] = 0;
          detallesPorProducto[item.item] = [];
        }
        consumosPorProducto[item.item] += item.quantity;
        detallesPorProducto[item.item].push({
          tipo: 'producto',
          itemIndex,
          cantidad: item.quantity
        });
      } else if (item.type === 'servicio') {
        const Servicio = require('../models/Servicio');
        const servicio = await Servicio.findById(item.item).session(session);
        if (servicio && servicio.insumos && servicio.insumos.length > 0) {
          for (const insumo of servicio.insumos) {
            const cantidadUsada = insumo.cantidad * item.quantity;
            if (!consumosPorProducto[insumo.producto]) {
              consumosPorProducto[insumo.producto] = 0;
              detallesPorProducto[insumo.producto] = [];
            }
            consumosPorProducto[insumo.producto] += cantidadUsada;
            detallesPorProducto[insumo.producto].push({
              tipo: 'servicio',
              itemIndex,
              servicio: servicio._id,
              insumo: insumo.producto,
              cantidad: cantidadUsada
            });
          }
        }
      }
    }

    // 2. Validar disponibilidad de capas FIFO para cada producto
    for (const productoId in consumosPorProducto) {
      const cantidadRequerida = consumosPorProducto[productoId];

      const producto = await Producto.findById(productoId).session(session);
      if (!producto) {
        throw fifoError(`Producto con ID ${productoId} no encontrado`, 404);
      }

      const activeLayers = await InventoryLayer.find({
        producto: productoId,
        isActive: true,
        remainingQuantity: { $gt: 0 }
      }).sort({ receivedDate: 1, _id: 1 }).session(session);

      const totalRemaining = activeLayers.reduce((sum, layer) => sum + layer.remainingQuantity, 0);

      // Validación de sincronía: producto.stock debe igualar suma de remainingQuantity de capas activas
      if (Math.abs(producto.stock - totalRemaining) > 0.01) {
        throw fifoError(`Inconsistencia detectada para producto ${producto.name}. Stock: ${producto.stock}, Capas: ${totalRemaining}. Contacte al administrador.`, 409);
      }

      if (totalRemaining < cantidadRequerida) {
        throw fifoError(`Stock insuficiente para ${producto.name}. Disponible: ${totalRemaining}, Solicitado: ${cantidadRequerida}`, 400);
      }
    }

    // 3. Consumir capas FIFO para cada producto agrupado
    for (const productoId in consumosPorProducto) {
      const cantidadRequerida = consumosPorProducto[productoId];
      const detalles = detallesPorProducto[productoId];

      const activeLayers = await InventoryLayer.find({
        producto: productoId,
        isActive: true,
        remainingQuantity: { $gt: 0 }
      }).sort({ receivedDate: 1, _id: 1 }).session(session);

      let remainingToConsume = cantidadRequerida;
      const layersConsumed = [];

      for (const layer of activeLayers) {
        if (remainingToConsume <= 0) break;

        const consumeQuantity = Math.min(remainingToConsume, layer.remainingQuantity);

        if (consumeQuantity < 0) {
          throw new Error(`Cantidad no puede ser negativa. Solicitado: ${consumeQuantity}`);
        }

        if (consumeQuantity > layer.remainingQuantity) {
          throw new Error(`Cantidad insuficiente en capa. Disponible: ${layer.remainingQuantity}, Solicitado: ${consumeQuantity}`);
        }

        const newRemaining = layer.remainingQuantity - consumeQuantity;
        if (newRemaining < 0) {
          throw new Error(`Resultado de remainingQuantity sería negativo`);
        }

        if (newRemaining > layer.initialQuantity) {
          throw new Error(`remainingQuantity (${newRemaining}) excedería initialQuantity (${layer.initialQuantity})`);
        }

        layer.remainingQuantity = newRemaining;

        if (layer.remainingQuantity === 0) {
          layer.isExhausted = true;
          layer.exhaustedDate = new Date();
        }

        await layer.save({ session });

        layersConsumed.push({
          layer: layer._id,
          quantityConsumed: consumeQuantity,
          unitCost: layer.unitCost,
          cost: consumeQuantity * layer.unitCost
        });

        remainingToConsume -= consumeQuantity;
      }

      const producto = await Producto.findById(productoId).session(session);
      producto.stock -= cantidadRequerida;
      await producto.save({ session });

      // F6: asignar las capas consumidas a cada línea en orden FIFO (no prorrateando).
      // Antes cada línea recibía una fracción de TODAS las capas, con redondeo a 2 decimales
      // (p. ej. 0.33 + 0.67 unidades), y la reversión no restauraba cantidades exactas.
      const pendientesPorCapa = layersConsumed.map(l => ({ ...l, restante: l.quantityConsumed }));
      const EPS = 1e-9;

      for (const detalle of detalles) {
        let porAsignar = detalle.cantidad;
        const asignadas = [];
        for (const capa of pendientesPorCapa) {
          if (porAsignar <= EPS) break;
          if (capa.restante <= EPS) continue;
          const q = Math.min(porAsignar, capa.restante);
          asignadas.push({ layer: capa.layer, quantityConsumed: q, unitCost: capa.unitCost, cost: q * capa.unitCost });
          capa.restante -= q;
          porAsignar -= q;
        }
        if (porAsignar > EPS) {
          throw new Error(`Asignación FIFO incompleta para producto ${productoId} (faltan ${porAsignar})`);
        }

        const totalCost = asignadas.reduce((sum, l) => sum + l.cost, 0);
        const movement = new InventoryMovement({
          producto: productoId,
          type: 'salida',
          quantity: -detalle.cantidad,
          unitCost: totalCost / detalle.cantidad, // costo unitario promedio de esta línea
          totalCost,
          layersConsumed: asignadas,
          source: detalle.tipo === 'servicio' ? 'servicio' : 'venta',
          sourceId: ventaId,
          ...(detalle.tipo === 'servicio' && { service: detalle.servicio }),
          saleItemIndex: detalle.itemIndex,
          sale: ventaId,
          date: ventaDate,
          user: userId,
          operationId: operationId,
          movementId: require('uuid').v4()
        });
        await movement.save({ session });
      }
    }

    return {
      success: true,
      message: 'Consumo FIFO completado exitosamente'
    };
  } catch (error) {
    throw error;
  }
}

module.exports = { consumirFIFOEnVenta };

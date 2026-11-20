const Mascota = require('../models/Mascota');
const Servicio = require('../models/Servicio');

/**
 * Función para actualizar historial médico y carnet después de una edición
 * Crea nuevos registros médicos y de carnet
 * Respeta las relaciones reales del sistema:
 * - Historial médico: se crea para servicios
 * - Carnet: se crea para productos de categoría 'vacunas' o 'desparasitantes'
 * NO actualiza replacedBy de registros originales (ya fueron marcados por revertirHistorialMedicoYCarnet)
 *
 * @param {Object} venta - Documento de venta actualizado
 * @param {Array} items - Items de la venta
 * @param {String} operationId - ID de la operación (para trazabilidad)
 * @param {Object} session - Sesión de MongoDB
 * @returns {Promise<Object>} - Resultado de la actualización
 */
async function actualizarHistorialMedicoYCarnet(venta, items, operationId, session) {
  try {
    // 1. Crear nuevos registros médicos para servicios
    for (const item of items) {
      if (item.type === 'servicio' && item.mascota) {
        const servicio = await Servicio.findById(item.item).session(session);
        if (servicio) {
          const mascota = await Mascota.findById(item.mascota).session(session);
          if (mascota) {
            // Crear nuevo registro médico (respetando formato del POST)
            await Mascota.findByIdAndUpdate(
              item.mascota,
              {
                $push: {
                  medicalHistory: {
                    date: venta.date,
                    description: `Servicio: ${servicio.name} (Venta #${venta._id})`,
                    veterinarian: venta.user ? venta.user.name : 'Sistema',
                    cost: item.subtotal || (item.quantity * item.unitPrice),
                    sale: venta._id,
                    service: servicio._id
                  }
                }
              },
              { session }
            );
          }
        }
      }
    }

    // 2. Vacunas y desparasitantes: se registran en el carnet con helpers/carnetVentaEditada.js
    //    (corrige la próxima dosis de las aplicaciones de la venta o agrega las que falten, sin duplicar).

    return {
      success: true,
      message: 'Historial médico y carnet actualizados exitosamente'
    };
  } catch (error) {
    throw error;
  }
}

module.exports = { actualizarHistorialMedicoYCarnet };

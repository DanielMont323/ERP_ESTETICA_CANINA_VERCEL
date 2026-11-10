const Mascota = require('../models/Mascota');
const CarnetVacunacion = require('../models/CarnetVacunacion');
const Servicio = require('../models/Servicio');
const Producto = require('../models/Producto');
const Cliente = require('../models/Cliente');

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

    // 2. Identificar productos de vacunas y desparasitantes en los items
    const vaccineProducts = [];
    const dewormerProducts = [];

    for (const item of items) {
      if (item.type === 'producto') {
        const producto = await Producto.findById(item.item).session(session);
        if (producto && producto.category) {
          const categoryLower = String(producto.category).toLowerCase();
          if (categoryLower === 'vacunas' || categoryLower === 'vacuna') {
            vaccineProducts.push({
              producto: producto._id,
              quantity: item.quantity,
              mascota: item.mascota || venta.mascota
            });
          } else if (categoryLower === 'desparasitantes' || categoryLower === 'desparasitante') {
            dewormerProducts.push({
              producto: producto._id,
              quantity: item.quantity,
              mascota: item.mascota || venta.mascota
            });
          }
        }
      }
    }

    // 3. Crear registros de carnet para vacunas
    for (const { producto, quantity, mascota } of vaccineProducts) {
      if (!mascota) continue;
      
      const productoDoc = await Producto.findById(producto).session(session);
      const mascotaDoc = await Mascota.findById(mascota).session(session);
      const clienteDoc = await Cliente.findById(venta.customer).session(session);

      if (!mascotaDoc || !clienteDoc) continue;

      let carnet = await CarnetVacunacion.findOne({ mascota }).session(session);
      if (!carnet) {
        carnet = new CarnetVacunacion({
          mascota,
          nombreMascota: mascotaDoc.name,
          especie: mascotaDoc.type,
          raza: mascotaDoc.breed,
          propietario: venta.customer,
          nombrePropietario: clienteDoc.name,
          vacunas: []
        });
      }

      for (let i = 0; i < quantity; i++) {
        const vacunaEntry = {
          vacuna: producto,
          nombre: productoDoc.name,
          tipo: 'vacuna',
          fecha: venta.date,
          venta: venta._id,
          replacedBy: null
        };
        carnet.vacunas.push(vacunaEntry);
      }

      await carnet.save({ session });
    }

    // 4. Crear registros de carnet para desparasitantes
    for (const { producto, quantity, mascota } of dewormerProducts) {
      if (!mascota) continue;
      
      const productoDoc = await Producto.findById(producto).session(session);
      const mascotaDoc = await Mascota.findById(mascota).session(session);
      const clienteDoc = await Cliente.findById(venta.customer).session(session);

      if (!mascotaDoc || !clienteDoc) continue;

      let carnet = await CarnetVacunacion.findOne({ mascota }).session(session);
      if (!carnet) {
        carnet = new CarnetVacunacion({
          mascota,
          nombreMascota: mascotaDoc.name,
          especie: mascotaDoc.type,
          raza: mascotaDoc.breed,
          propietario: venta.customer,
          nombrePropietario: clienteDoc.name,
          vacunas: []
        });
      }

      for (let i = 0; i < quantity; i++) {
        const vacunaEntry = {
          vacuna: producto,
          nombre: productoDoc.name,
          tipo: 'desparasitante',
          fecha: venta.date,
          venta: venta._id,
          replacedBy: null
        };
        carnet.vacunas.push(vacunaEntry);
      }

      await carnet.save({ session });
    }

    return {
      success: true,
      message: 'Historial médico y carnet actualizados exitosamente'
    };
  } catch (error) {
    throw error;
  }
}

module.exports = { actualizarHistorialMedicoYCarnet };

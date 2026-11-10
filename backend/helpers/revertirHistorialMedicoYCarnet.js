const Mascota = require('../models/Mascota');
const CarnetVacunacion = require('../models/CarnetVacunacion');

/**
 * Función para revertir (marcar) registros médicos y de carnet de una venta
 * NO elimina registros, solo marca el campo replacedBy
 *
 * @param {ObjectId} ventaId - ID de la venta
 * @param {String} operationId - ID de la operación (para trazabilidad)
 * @param {Object} session - Sesión de MongoDB
 * @returns {Promise<Object>} - Resultado de la reversión
 */
async function revertirHistorialMedicoYCarnet(ventaId, operationId, session) {
  try {
    // 1. Buscar mascotas que tienen registros médicos que referencian la venta
    const mascotas = await Mascota.find({
      'medicalHistory.sale': ventaId
    }).session(session);

    // 2. Marcar registros médicos originales con replacedBy: null (se llenará después de crear nuevos)
    for (const mascota of mascotas) {
      for (let i = 0; i < mascota.medicalHistory.length; i++) {
        if (mascota.medicalHistory[i].sale && mascota.medicalHistory[i].sale.toString() === ventaId.toString()) {
          mascota.medicalHistory[i].replacedBy = null;
        }
      }
      await mascota.save({ session });
    }

    // 3. Buscar registros de carnet que referencian la venta
    const carnets = await CarnetVacunacion.find({
      'vacunas.venta': ventaId
    }).session(session);

    // 4. Marcar registros de carnet originales con replacedBy: null (se llenará después de crear nuevos)
    for (const carnet of carnets) {
      for (let i = 0; i < carnet.vacunas.length; i++) {
        if (carnet.vacunas[i].venta && carnet.vacunas[i].venta.toString() === ventaId.toString()) {
          carnet.vacunas[i].replacedBy = null;
        }
      }
      await carnet.save({ session });
    }

    return {
      success: true,
      message: 'Historial médico y carnet marcados para reversión'
    };
  } catch (error) {
    throw error;
  }
}

module.exports = { revertirHistorialMedicoYCarnet };

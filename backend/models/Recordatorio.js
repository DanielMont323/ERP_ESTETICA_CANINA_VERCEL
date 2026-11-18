const mongoose = require('mongoose');
const { getCurrentDateGMT7 } = require('../helpers/timezone');

const recordatorioSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'El título es obligatorio'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  date: {
    type: Date,
    required: [true, 'La fecha es obligatoria']
  },
  type: {
    type: String,
    enum: ['pago', 'vacuna', 'consulta', 'cita', 'inventario', 'mantenimiento', 'otro'],
    required: [true, 'El tipo es obligatorio']
  },
  priority: {
    type: String,
    enum: ['baja', 'media', 'alta'],
    default: 'media'
  },
  relatedId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false
  },
  relatedModel: {
    type: String,
    enum: ['Cliente', 'Mascota', 'Proveedor', 'CuentaPorPagar', 'Costo'],
    required: false
  },
  status: {
    type: String,
    enum: ['pendiente', 'completado', 'cancelado'],
    default: 'pendiente'
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: false
  },
  completedAt: {
    type: Date
  },
  // --- Campos agregados 2026-11 (opcionales; los recordatorios anteriores no los tienen) ---
  // Quién lo completó y por qué: 'manual' (botón) o automático al pagar/cancelar la cuenta ligada
  completadoPor: {
    usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    nombre: { type: String, trim: true },
    motivo: { type: String, enum: ['manual', 'cuenta_pagada', 'cuenta_cancelada'] }
  },
  // Aviso al dueño de la mascota (vacunas/desparasitantes). NO completa el recordatorio.
  duenoNotificado: {
    fecha: { type: Date },
    usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    nombre: { type: String, trim: true }
  },
  // Cuenta por pagar a la que pertenece un recordatorio de pago (al liquidarse se completa sola)
  cuentaPorPagar: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CuentaPorPagar'
  },
  createdAt: {
    type: Date,
    default: getCurrentDateGMT7
  }
});

// Marcar como completado
recordatorioSchema.methods.complete = function(usuario) {
  this.status = 'completado';
  this.completedAt = new Date();
  if (usuario) this.completadoPor = { usuario: usuario._id, nombre: usuario.name, motivo: 'manual' };
  return this.save();
};

module.exports = mongoose.model('Recordatorio', recordatorioSchema);

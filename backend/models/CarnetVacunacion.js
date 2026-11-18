const mongoose = require('mongoose');
const { getCurrentDateGMT7 } = require('../helpers/timezone');

const vacunaSchema = new mongoose.Schema({
  // Compatibilidad: acepta ObjectId (nuevo) o String (histórico)
  vacuna: {
    type: mongoose.Schema.Types.Mixed, // ObjectId o String
    required: true
  },
  nombre: {
    type: String,
    trim: true
  },
  tipo: {
    type: String,
    enum: ['vacuna', 'desparasitante'],
    default: 'vacuna'
  },
  fecha: {
    type: Date,
    required: true
  },
  proximaDosis: {
    type: Date
  },
  diasProximaDosis: {
    type: Number,
    min: 0
  },
  observaciones: {
    type: String,
    trim: true
  },
  venta: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Venta'
  },
  replacedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CarnetVacunacion'
  },
  // --- Campos agregados 2026-11 (opcionales) para el recordatorio de la PRÓXIMA dosis ---
  // Recordatorio atendido (se completó desde Recordatorios)
  atendido: {
    fecha: { type: Date },
    usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    nombre: { type: String, trim: true }
  },
  // Se avisó al dueño que la próxima dosis está pendiente. NO significa que se aplicó.
  duenoNotificado: {
    fecha: { type: Date },
    usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    nombre: { type: String, trim: true }
  }
});

const carnetVacunacionSchema = new mongoose.Schema({
  mascota: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mascota',
    required: true,
    unique: true
  },
  nombreMascota: {
    type: String,
    required: true
  },
  especie: {
    type: String,
    required: true
  },
  raza: {
    type: String,
    required: true
  },
  propietario: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cliente',
    required: true
  },
  nombrePropietario: {
    type: String,
    required: true
  },
  vacunas: [vacunaSchema],
  createdAt: {
    type: Date,
    default: getCurrentDateGMT7
  },
  updatedAt: {
    type: Date,
    default: getCurrentDateGMT7
  }
});

// Actualizar updatedAt antes de guardar
carnetVacunacionSchema.pre('save', function(next) {
  this.updatedAt = getCurrentDateGMT7();
  next();
});

module.exports = mongoose.model('CarnetVacunacion', carnetVacunacionSchema);

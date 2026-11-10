const mongoose = require('mongoose');

const fifoInitializationSchema = new mongoose.Schema({
  identifier: {
    type: String,
    default: 'global',
    unique: true
  },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'partial', 'failed'],
    default: 'pending'
  },
  initializationDate: {
    type: Date
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario'
  },
  productsProcessed: {
    type: Number,
    default: 0
  },
  productsTotal: {
    type: Number,
    default: 0
  },
  productsSuccess: {
    type: Number,
    default: 0
  },
  productsFailed: {
    type: Number,
    default: 0
  },
  productsSkipped: {
    type: Number,
    default: 0
  },
  layersCreated: {
    type: Number,
    default: 0
  },
  movementsCreated: {
    type: Number,
    default: 0
  },
  productsWithErrors: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Producto'
    },
    productName: String,
    sku: String,
    error: String,
    reason: String
  }],
  productsProcessedIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Producto'
  }],
  lastAttemptDate: {
    type: Date
  },
  attemptCount: {
    type: Number,
    default: 0
  },
  notes: {
    type: String
  },
  completedAt: {
    type: Date
  },
  lockOwnerId: {
    type: String,
    description: 'Identificador único del propietario del lock para evitar liberación por otros procesos'
  },
  lockExpiresAt: {
    type: Date,
    description: 'Fecha de expiración del lock para recuperación automática'
  }
}, {
  timestamps: true
});

// Índice único para garantizar singleton
fifoInitializationSchema.index({ identifier: 1 }, { unique: true });

module.exports = mongoose.model('FIFOInitialization', fifoInitializationSchema);

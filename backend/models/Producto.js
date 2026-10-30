const mongoose = require('mongoose');

const productoSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'El nombre del producto es obligatorio'],
    trim: true
  },
  category: {
    type: mongoose.Schema.Types.Mixed, // Acepta String o ObjectId para compatibilidad
    trim: true
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Proveedor',
    required: false
  },
  cost: {
    type: Number,
    required: [true, 'El costo es obligatorio'],
    min: 0
  },
  price: {
    type: Number,
    required: [true, 'El precio de venta es obligatorio'],
    min: 0
  },
  stock: {
    type: Number,
    required: [true, 'El stock es obligatorio'],
    min: 0,
    default: 0
  },
  unit: {
    type: String,
    enum: ['pieza', 'ml', 'litro', 'kg', 'gramo'],
    default: 'pieza'
  },
  minStock: {
    type: Number,
    default: 5,
    min: 0
  },
  idealStock: {
    type: Number,
    min: 0
  },
  sku: {
    type: String,
    unique: true,
    required: [true, 'El SKU es obligatorio']
  },
  discountPercentage: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario'
  },
  expirationDate: {
    type: Date,
    required: false
  },
  isPerishable: {
    type: Boolean,
    default: false
  },
  lotNumber: {
    type: String,
    trim: true,
    required: false
  },
  alertDays: {
    type: Number,
    default: 30,
    min: 0,
    description: 'Días antes de la caducidad para mostrar alerta'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Calcular margen de ganancia
productoSchema.virtual('margin').get(function() {
  // Calcular precio final después del descuento
  const discountPercent = this.discountPercentage || 0;
  const finalPrice = this.price * (1 - discountPercent / 100);
  
  // Validar que tengamos valores válidos
  if (!this.cost || !this.price || this.cost < 0 || this.price < 0) {
    return null; // Retornar null para casos inválidos
  }
  
  // Si el precio final es 0 o menor, no calcular margen
  if (finalPrice <= 0) {
    return null;
  }
  
  // Calcular margen: ((Precio final - Costo) / Precio final) × 100
  const margin = ((finalPrice - this.cost) / finalPrice) * 100;
  
  // Retornar con 2 decimales
  return margin.toFixed(2);
});

// Actualizar updatedAt antes de guardar
productoSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Índices para optimizar consultas
productoSchema.index({ name: 1 });
productoSchema.index({ category: 1 });
productoSchema.index({ supplier: 1 });
productoSchema.index({ isActive: 1 });
productoSchema.index({ isDeleted: 1 });
productoSchema.index({ stock: 1 });
productoSchema.index({ isActive: 1, isDeleted: 1 });
productoSchema.index({ name: 1, isActive: 1, isDeleted: 1 });

module.exports = mongoose.model('Producto', productoSchema);

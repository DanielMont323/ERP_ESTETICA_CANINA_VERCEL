const mongoose = require('mongoose');

const inventoryLayerSchema = new mongoose.Schema({
  producto: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Producto',
    required: true,
    index: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 0
  },
  initialQuantity: {
    type: Number,
    required: true,
    min: 0,
    validate: {
      validator: function(v) {
        return v > 0;
      },
      message: 'initialQuantity debe ser mayor que cero'
    }
  },
  unitCost: {
    type: Number,
    required: true,
    min: 0
  },
  totalCost: {
    type: Number,
    required: true,
    min: 0
  },
  // Trazabilidad del costo (opcional; las capas anteriores no lo tienen):
  //   'compra'          costo de una compra registrada (comprobado)
  //   'costo_capturado' Producto.cost al abrir el inventario FIFO (estimado)
  //   'sin_costo'       el producto no tenía costo: capa a $0, sin costo comprobable
  costSource: {
    type: String,
    enum: ['compra', 'costo_capturado', 'sin_costo']
  },
  source: {
    type: String,
    enum: ['inventario_inicial', 'compra', 'ajuste_entrada'],
    required: true
  },
  purchase: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Compra'
  },
  tempPurchaseId: {
    type: String,
    // Campo temporal para protección contra duplicados durante transacción
  },
  compraItemIndex: {
    type: Number
  },
  compraVersion: {
    type: Number
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Proveedor'
  },
  isInitialLayer: {
    type: Boolean,
    default: false
  },
  initializationDate: {
    type: Date
  },
  receivedDate: {
    type: Date,
    required: true
  },
  expirationDate: {
    type: Date
  },
  lotNumber: {
    type: String
  },
  remainingQuantity: {
    type: Number,
    required: true,
    min: 0,
    validate: {
      validator: function(v) {
        // remainingQuantity nunca puede exceder initialQuantity
        return v <= this.initialQuantity;
      },
      message: 'remainingQuantity no puede exceder initialQuantity'
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isExhausted: {
    type: Boolean,
    default: false
  },
  exhaustedDate: {
    type: Date
  },
  notes: {
    type: String,
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Índices para optimizar consultas FIFO
// Orden determinista: receivedDate ascendente, _id ascendente como tie-breaker
inventoryLayerSchema.index({ producto: 1, receivedDate: 1, _id: 1, isActive: 1 });
inventoryLayerSchema.index({ producto: 1, isExhausted: 1 });
// F10: el campo real es "purchase" (antes el índice apuntaba a "compra", que no existe).
inventoryLayerSchema.index({ purchase: 1 });
inventoryLayerSchema.index({ source: 1 });

// Índice único para impedir duplicados de capa inicial por producto
// Solo aplica a capas iniciales (isInitialLayer: true, source: 'inventario_inicial')
// Las capas de compras pueden ser múltiples (source: 'compra')
inventoryLayerSchema.index({ producto: 1, source: 1, isInitialLayer: 1 }, { 
  unique: true, 
  partialFilterExpression: { 
    isInitialLayer: true, 
    source: 'inventario_inicial' 
  } 
});

// Método para consumir cantidad de esta capa
inventoryLayerSchema.methods.consume = function(quantity) {
  // Validaciones explícitas antes de modificar
  if (quantity < 0) {
    throw new Error(`Cantidad no puede ser negativa. Solicitado: ${quantity}`);
  }
  
  if (quantity > this.remainingQuantity) {
    throw new Error(`Cantidad insuficiente en capa. Disponible: ${this.remainingQuantity}, Solicitado: ${quantity}`);
  }
  
  if (this.remainingQuantity - quantity < 0) {
    throw new Error(`Resultado de remainingQuantity sería negativo`);
  }
  
  const newRemaining = this.remainingQuantity - quantity;
  if (newRemaining > this.initialQuantity) {
    throw new Error(`remainingQuantity (${newRemaining}) excedería initialQuantity (${this.initialQuantity})`);
  }
  
  // Modificar solo después de validar
  this.remainingQuantity = newRemaining;
  
  if (this.remainingQuantity === 0) {
    this.isExhausted = true;
    this.exhaustedDate = new Date();
  }
  
  return this.save();
};

// Método virtual para calcular porcentaje consumido
inventoryLayerSchema.virtual('consumedPercentage').get(function() {
  if (this.initialQuantity === 0) return 0;
  return ((this.initialQuantity - this.remainingQuantity) / this.initialQuantity * 100).toFixed(2);
});

module.exports = mongoose.model('InventoryLayer', inventoryLayerSchema);

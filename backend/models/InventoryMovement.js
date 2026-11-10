const mongoose = require('mongoose');

const inventoryMovementSchema = new mongoose.Schema({
  producto: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Producto',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['entrada', 'salida', 'ajuste_entrada', 'ajuste_salida'],
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    validate: {
      validator: function(v) {
        // Entradas y ajustes de entrada deben ser positivos
        if (['entrada', 'ajuste_entrada'].includes(this.type)) {
          return v > 0;
        }
        // Salidas y ajustes de salida deben ser negativos
        if (['salida', 'ajuste_salida'].includes(this.type)) {
          return v < 0;
        }
        return true;
      },
      message: 'quantity debe ser positivo para entradas/ajustes de entrada y negativo para salidas/ajustes de salida'
    }
  },
  unitCost: {
    type: Number,
    min: 0
  },
  totalCost: {
    type: Number,
    min: 0,
    validate: {
      validator: function(v) {
        // totalCost siempre debe ser positivo (valor económico absoluto)
        if (v < 0) {
          return false;
        }
        // Si hay layersConsumed, totalCost debe ser igual a la suma de los costos
        if (this.layersConsumed && this.layersConsumed.length > 0) {
          const layersCost = this.layersConsumed.reduce((sum, layer) => sum + layer.cost, 0);
          return Math.abs(v - layersCost) < 0.01; // Tolerancia para redondeo
        }
        // Si no hay layersConsumed, totalCost debe ser Math.abs(quantity) * unitCost
        if (this.unitCost !== undefined && this.unitCost !== null) {
          return Math.abs(v - (Math.abs(this.quantity) * this.unitCost)) < 0.01;
        }
        // Si no hay unitCost ni layersConsumed, no validar
        return true;
      },
      message: 'totalCost debe ser positivo (valor económico absoluto)'
    }
  },
  layersConsumed: [{
    layer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryLayer'
    },
    quantityConsumed: {
      type: Number,
      required: true
    },
    unitCost: {
      type: Number,
      required: true
    },
    cost: {
      type: Number,
      required: true
    }
  }],
  source: {
    type: String,
    enum: ['compra', 'venta', 'servicio', 'ajuste', 'inventario_inicial', 'cancelacion_compra', 'modificacion_compra', 'reversion_venta', 'edicion_venta'],
    required: true
  },
  sourceId: {
    type: mongoose.Schema.Types.ObjectId
  },
  tempSourceId: {
    type: String,
    // Campo temporal para protección contra duplicados durante transacción
  },
  sourceItemIndex: {
    type: Number
  },
  sourceVersion: {
    type: Number
  },
  sale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Venta'
  },
  saleItemIndex: {
    type: Number
  },
  service: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Servicio'
  },
  reference: {
    type: String
  },
  date: {
    type: Date,
    required: true,
    default: Date.now
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario'
  },
  notes: {
    type: String,
    trim: true
  },
  // Campos de idempotencia y trazabilidad para PUT FIFO
  operationId: {
    type: String,
    index: true,
    default: null
  },
  // F17: sin "default: null". Un índice único sparse solo ignora documentos SIN el campo;
  // con null, el segundo movimiento sin movementId fallaba con E11000.
  movementId: {
    type: String,
    index: { unique: true, sparse: true }
  },
  operationBatchId: {
    type: String,
    index: true,
    default: null
  },
  originalMovement: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InventoryMovement'
  },
  reversalReason: {
    type: String,
    enum: ['edicion_venta', 'cancelacion_venta', 'error_correccion', null],
    default: null
  }
}, {
  timestamps: true
});

inventoryMovementSchema.index({ producto: 1, date: -1 });
inventoryMovementSchema.index({ type: 1, date: -1 });
inventoryMovementSchema.index({ source: 1, sourceId: 1 });

module.exports = mongoose.model('InventoryMovement', inventoryMovementSchema);

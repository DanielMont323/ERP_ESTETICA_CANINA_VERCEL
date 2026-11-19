const mongoose = require('mongoose');
const { getCurrentDateGMT7, hoyCalendarioTepic } = require('../helpers/timezone');

const itemCompraSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Producto',
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  baseUnitCost: {
    type: Number,
    required: true,
    min: 0
  },
  unitCost: {
    type: Number,
    required: true,
    min: 0
  },
  discountPercentage: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },
  discountDays: {
    type: Number,
    min: 0,
    default: 0
  },
  discountApplied: {
    type: Boolean,
    default: false
  },
  subtotal: {
    type: Number,
    required: false,
    min: 0
  },
  discountAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  hasTax: {
    type: Boolean,
    default: true
  },
  taxRate: {
    type: Number,
    default: 0.16,
    min: 0
  },
  costIncludesTax: {
    type: Boolean,
    default: false,
    description: 'Indica si unitCost incluye IVA'
  },
  // Opcional (agregado 2026-11): caducidad del lote comprado; se copia a su capa FIFO
  expirationDate: {
    type: Date
  }
});

const compraSchema = new mongoose.Schema({
  proveedor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Proveedor',
    required: true
  },
  items: [itemCompraSchema],
  total: {
    type: Number,
    required: false,
    min: 0
  },
  baseTotal: {
    type: Number,
    required: false,
    min: 0
  },
  totalDiscount: {
    type: Number,
    default: 0,
    min: 0
  },
  earlyPaymentDiscount: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  discountDeadline: {
    type: Date
  },
  type: {
    type: String,
    enum: ['contado', 'credito'],
    required: true
  },
  dueDate: {
    type: Date,
    required: function() {
      return this.type === 'credito';
    }
  },
  status: {
    type: String,
    enum: ['pendiente', 'pagada', 'vencida', 'cancelada', 'modificando'],
    default: function() {
      return this.type === 'contado' ? 'pagada' : 'pendiente';
    }
  },
  paymentMethod: {
    type: String,
    enum: ['efectivo', 'transferencia', 'tarjeta'],
    required: function() {
      return this.type === 'contado';
    }
  },
  invoice: {
    type: String,
    trim: true
  },
  idempotencyKey: {
    type: String,
    unique: true,
    sparse: true
  },
  lastModificationIdempotencyKey: {
    type: String,
    sparse: true
  },
  modificationIdempotencyKeys: [{
    key: String,
    version: Number,
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  notes: {
    type: String,
    trim: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: true
  },
  date: {
    type: Date,
    // Fecha de calendario de Tepic (antes getCurrentDateGMT7, que adelantaba un día después de las 10:00)
    default: () => hoyCalendarioTepic()
  },
  version: {
    type: Number,
    default: 1
  },
  previousVersion: {
    type: Number
  },
  lockToken: {
    type: String,
    sparse: true
  },
  lockExpiresAt: {
    type: Date,
    sparse: true
  },
  // Compra borrada que se reconstruyó sin productos (p. ej. desde su recordatorio de pago).
  // No tiene productos, no mueve inventario ni capas FIFO; su total es el monto recuperado.
  recuperada: {
    origen: { type: String, enum: ['recordatorio_pago'] },
    recordatorio: { type: mongoose.Schema.Types.ObjectId, ref: 'Recordatorio' },
    referenciaOriginal: { type: String, trim: true }, // folio o _id de la compra borrada
    monto: { type: Number, min: 0 },
    restauradaEl: { type: Date },
    nota: { type: String, trim: true }
  }
});

const esCompraRecuperada = compra => Boolean(compra && compra.recuperada && compra.recuperada.origen);

// Calcular totales antes de guardar
compraSchema.pre('save', async function(next) {
  // Compra recuperada sin productos: el total es el monto recuperado (no hay items de dónde calcularlo)
  if (esCompraRecuperada(this) && this.items.length === 0) {
    const monto = Math.round((this.recuperada.monto || 0) * 100) / 100;
    this.baseTotal = monto;
    this.totalDiscount = 0;
    this.totalIVA = 0;
    this.total = monto;
    return next();
  }

  // Calcular subtotal, descuentos e IVA de cada item
  let baseTotal = 0;
  let totalDiscount = 0;
  let totalIVA = 0;
  
  this.items.forEach(item => {
    // Calcular subtotal base (sin descuento)
    const baseSubtotal = item.quantity * item.baseUnitCost;
    
    // Calcular descuento si aplica (solo descuento por item, no por pronto pago)
    let discountAmount = 0;
    if (item.discountPercentage > 0 && !item.discountApplied) {
      discountAmount = baseSubtotal * (item.discountPercentage / 100);
    }
    
    // Calcular subtotal final
    item.subtotal = baseSubtotal - discountAmount;
    item.discountAmount = discountAmount;
    
    // Calcular IVA del item si aplica
    const itemTax = (item.hasTax !== false) ? (item.subtotal * (item.taxRate || 0.16)) : 0;
    
    baseTotal += baseSubtotal;
    totalDiscount += discountAmount;
    totalIVA += itemTax;
  });
  
  // Establecer totales base
  this.baseTotal = baseTotal;
  
  // Aplicar descuento por pronto pago del proveedor si es crédito
  if (this.type === 'credito' && this.earlyPaymentDiscount > 0) {
    const earlyPaymentDiscountAmount = baseTotal * (this.earlyPaymentDiscount / 100);
    this.totalDiscount = totalDiscount + earlyPaymentDiscountAmount;
    this.total = baseTotal - this.totalDiscount + totalIVA;
  } else {
    this.totalDiscount = totalDiscount;
    this.total = baseTotal - totalDiscount + totalIVA;
  }
  
  // Guardar IVA total en el documento para referencia
  this.totalIVA = totalIVA;
  
  // Establecer fecha límite de descuento (ya viene del backend si es crédito)
  // No recalcular aquí porque ya se establece en el endpoint
  
  // Establecer fecha de vencimiento para compras a crédito usando creditDays del proveedor
  // SOLO si dueDate no está establecido por el endpoint
  console.log(`Compra pre-save: type=${this.type}, dueDate=${this.dueDate ? this.dueDate.toISOString() : 'undefined'}, proveedor=${this.proveedor}`);
  
  if (this.type === 'credito' && !this.dueDate && this.proveedor) {
    console.log('Compra: Calculando dueDate en pre-save hook');
    try {
      const Proveedor = require('./Proveedor');
      const proveedor = await Proveedor.findById(this.proveedor);
      if (proveedor && proveedor.creditDays > 0) {
        const purchaseDate = this.date || hoyCalendarioTepic();
        this.dueDate = new Date(purchaseDate);
        this.dueDate.setDate(this.dueDate.getDate() + proveedor.creditDays);
        console.log(`Compra: dueDate calculado: ${this.dueDate.toISOString()}`);
      } else {
        // Fallback a 30 días si no tiene creditDays configurado
        const purchaseDate = this.date || hoyCalendarioTepic();
        this.dueDate = new Date(purchaseDate);
        this.dueDate.setDate(this.dueDate.getDate() + 30);
        console.log(`Compra: dueDate calculado (fallback 30 días): ${this.dueDate.toISOString()}`);
      }
    } catch (error) {
      // Si hay error al obtener proveedor, usar 30 días por defecto
      const purchaseDate = this.date || hoyCalendarioTepic();
      this.dueDate = new Date(purchaseDate);
      this.dueDate.setDate(this.dueDate.getDate() + 30);
      console.log(`Compra: dueDate calculado (error fallback): ${this.dueDate.toISOString()}`);
    }
  } else if (this.type === 'credito' && this.dueDate) {
    // dueDate ya fue establecido por el endpoint, NO recalcular
    console.log(`Compra: dueDate ya establecido por el endpoint: ${this.dueDate.toISOString()}, NO se recalcula`);
  }
  
  next();
});

// Actualizar estado a vencido si pasa la fecha
compraSchema.methods.checkDueDate = function() {
  if (this.type === 'credito' && this.status === 'pendiente' && new Date() > this.dueDate) {
    this.status = 'vencida';
    return this.save();
  }
  return Promise.resolve(this);
};

module.exports = mongoose.model('Compra', compraSchema);
module.exports.esCompraRecuperada = esCompraRecuperada;

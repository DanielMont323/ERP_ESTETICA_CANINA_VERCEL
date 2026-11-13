const mongoose = require('mongoose');

const insumoServicioSchema = new mongoose.Schema({
  producto: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Producto',
    required: true
  },
  cantidad: {
    type: Number,
    required: true,
    min: 0
  }
});

const servicioSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'El nombre del servicio es obligatorio'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  price: {
    type: Number,
    required: [true, 'El precio del servicio es obligatorio'],
    min: 0
  },
  // Opcional: los estudios externos (laboratorio, rayos X) no tienen duración en la estética
  duration: {
    type: Number,
    min: 0
  },
  // Lo que cobra un tercero por cada servicio (p. ej. el laboratorio por un estudio).
  // Se guarda en cada venta y el reporte de ganancia lo resta como costo.
  costoExterno: {
    type: Number,
    min: 0,
    default: 0
  },
  proveedorExterno: {
    type: String,
    trim: true
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CategoriaServicio',
    required: [true, 'La categoría es obligatoria']
  },
  insumos: [insumoServicioSchema],
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
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Servicio', servicioSchema);

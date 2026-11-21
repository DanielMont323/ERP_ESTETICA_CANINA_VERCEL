const mongoose = require('mongoose');
const CategoriaProducto = require('../models/CategoriaProducto');

// Categorías de productos que se venden aunque no haya existencias (se hacen o se piden por encargo),
// p. ej. las plaquitas. Pedido del cliente 2026-11-21. Se decide por el nombre de la categoría,
// sin campos nuevos en la base de datos.
const esCategoriaSinStock = (nombre) => /^plaquitas?$/i.test(String(nombre || '').trim());

// Nombre de la categoría de un producto (la categoría se guarda como id en texto, ObjectId o nombre).
async function nombreCategoria(category, session = null) {
  if (!category) return '';
  if (typeof category === 'object' && category.name) return category.name;
  const valor = String(category);
  if (mongoose.Types.ObjectId.isValid(valor) && /^[0-9a-f]{24}$/i.test(valor)) {
    const cat = await CategoriaProducto.findById(valor).select('name').session(session).lean();
    return cat ? cat.name : '';
  }
  return valor;
}

async function productoSinStock(producto, session = null) {
  if (!producto) return false;
  return esCategoriaSinStock(await nombreCategoria(producto.category, session));
}

module.exports = { esCategoriaSinStock, nombreCategoria, productoSinStock };

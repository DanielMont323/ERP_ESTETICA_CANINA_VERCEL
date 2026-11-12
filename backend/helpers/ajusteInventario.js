/**
 * Ajuste manual de inventario (mermas, conteo físico, uso interno, sobrantes) respetando FIFO.
 *
 * - Salida: consume capas activas de la más antigua a la más reciente (igual que una venta) y crea un
 *   movimiento 'ajuste_salida' con las capas consumidas y su costo. Ese costo es la pérdida del ajuste.
 * - Entrada: crea una capa 'ajuste_entrada' y un movimiento 'ajuste_entrada'. Costo: el capturado;
 *   si no, el de la capa activa más reciente; si no, el de la capa de apertura; si no, Producto.cost;
 *   si no hay ninguno, $0 marcado 'sin_costo'.
 * Stock y capas cambian juntos dentro de la transacción; si ya no cuadraban antes, no se toca (409).
 */
const { v4: uuidv4 } = require('uuid');
const Producto = require('../models/Producto');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const { getCurrentDateGMT7 } = require('./timezone');

const MOTIVOS_SALIDA = ['merma', 'conteo_fisico', 'uso_interno', 'regalo', 'otro'];
const MOTIVOS_ENTRADA = ['conteo_fisico', 'devolucion_cliente', 'otro'];
const EPS = 1e-6;
const r2 = n => Math.round(n * 100) / 100;

function errorAjuste(message, httpStatus = 400) {
  const e = new Error(message);
  e.httpStatus = httpStatus;
  return e;
}

async function ajustarInventario({ productoId, tipo, cantidad, motivo, notas, costoUnitario, stockEsperado, stockContado, userId }, session) {
  cantidad = Number(cantidad);
  if (!['entrada', 'salida'].includes(tipo)) throw errorAjuste('El tipo de ajuste debe ser entrada o salida');
  if (!Number.isFinite(cantidad) || cantidad <= 0 || !Number.isInteger(cantidad)) throw errorAjuste('La cantidad debe ser un número entero mayor a 0');
  const motivos = tipo === 'salida' ? MOTIVOS_SALIDA : MOTIVOS_ENTRADA;
  if (!motivos.includes(motivo)) throw errorAjuste('Motivo de ajuste inválido');
  if (motivo === 'otro' && !String(notas || '').trim()) throw errorAjuste('Escribe una nota que explique el ajuste');

  const producto = await Producto.findById(productoId).session(session);
  if (!producto || producto.isDeleted) throw errorAjuste('Producto no encontrado', 404);

  // Protección contra cambios simultáneos: el stock que vio la persona debe ser el actual
  if (stockEsperado !== undefined && stockEsperado !== null && Math.abs(Number(stockEsperado) - producto.stock) > EPS) {
    throw errorAjuste(`El stock de "${producto.name}" cambió (ahora es ${producto.stock}). Vuelve a cargar y revisa el ajuste.`, 409);
  }

  const capas = await InventoryLayer.find({ producto: producto._id, isActive: true, remainingQuantity: { $gt: 0 } })
    .sort({ receivedDate: 1, _id: 1 }).session(session);
  const enCapas = capas.reduce((s, c) => s + c.remainingQuantity, 0);
  if (Math.abs(enCapas - producto.stock) > EPS) {
    throw errorAjuste(`El inventario de "${producto.name}" no cuadra (stock ${producto.stock}, capas ${enCapas}). Contacta al administrador del sistema.`, 409);
  }

  const fecha = getCurrentDateGMT7();
  const stockAntes = producto.stock;
  const base = {
    producto: producto._id,
    source: 'ajuste',
    adjustmentReason: motivo,
    date: fecha,
    user: userId,
    movementId: uuidv4(),
    notes: String(notas || '').trim() || undefined,
    stockAntes,
    ...(stockContado !== undefined && stockContado !== null && { stockContado: Number(stockContado) })
  };

  if (tipo === 'salida') {
    if (cantidad > producto.stock + EPS) throw errorAjuste(`No hay suficiente stock de "${producto.name}" (hay ${producto.stock})`);
    let porConsumir = cantidad;
    const consumidas = [];
    for (const capa of capas) {
      if (porConsumir <= EPS) break;
      const q = Math.min(porConsumir, capa.remainingQuantity);
      capa.remainingQuantity -= q;
      if (capa.remainingQuantity <= EPS) { capa.remainingQuantity = 0; capa.isExhausted = true; capa.exhaustedDate = new Date(); }
      await capa.save({ session });
      consumidas.push({ layer: capa._id, quantityConsumed: q, unitCost: capa.unitCost, cost: q * capa.unitCost });
      porConsumir -= q;
    }
    const totalCost = consumidas.reduce((s, c) => s + c.cost, 0);
    const [mov] = await InventoryMovement.create([{
      ...base, type: 'ajuste_salida', quantity: -cantidad,
      unitCost: totalCost / cantidad, totalCost: r2(totalCost), layersConsumed: consumidas
    }], { session });
    producto.stock -= cantidad;
    await producto.save({ session });
    return { movimiento: mov, stockAntes, stockDespues: producto.stock, costo: r2(totalCost) };
  }

  // Entrada
  let unitCost; let costSource;
  const capturado = costoUnitario !== undefined && costoUnitario !== null && costoUnitario !== '' ? Number(costoUnitario) : undefined;
  if (capturado !== undefined) {
    if (!Number.isFinite(capturado) || capturado < 0) throw errorAjuste('El costo unitario no es válido');
    unitCost = capturado; costSource = capturado > 0 ? 'costo_capturado' : 'sin_costo';
  } else {
    const referencia = capas.length ? capas[capas.length - 1]
      : await InventoryLayer.findOne({ producto: producto._id }).sort({ receivedDate: -1, _id: -1 }).session(session);
    if (referencia && referencia.unitCost > 0) { unitCost = referencia.unitCost; costSource = 'costo_capturado'; }
    else if (producto.cost > 0) { unitCost = producto.cost; costSource = 'costo_capturado'; }
    else { unitCost = 0; costSource = 'sin_costo'; }
  }
  const totalCost = r2(unitCost * cantidad);
  const [capa] = await InventoryLayer.create([{
    producto: producto._id, quantity: cantidad, initialQuantity: cantidad, remainingQuantity: cantidad,
    unitCost, totalCost, costSource, source: 'ajuste_entrada', isInitialLayer: false, receivedDate: fecha,
    notes: `Ajuste de inventario (${motivo})`
  }], { session });
  const [mov] = await InventoryMovement.create([{
    ...base, type: 'ajuste_entrada', quantity: cantidad, unitCost, totalCost, sourceId: capa._id
  }], { session });
  producto.stock += cantidad;
  if (!producto.fifoInitialized) { producto.fifoInitialized = true; producto.fifoInitializationDate = new Date(); }
  await producto.save({ session });
  return { movimiento: mov, stockAntes, stockDespues: producto.stock, costo: totalCost, costSource };
}

module.exports = { ajustarInventario, MOTIVOS_SALIDA, MOTIVOS_ENTRADA };

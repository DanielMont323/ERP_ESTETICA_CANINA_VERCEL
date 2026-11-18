const express = require('express');
const mongoose = require('mongoose');
const Producto = require('../models/Producto');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const FIFOInitialization = require('../models/FIFOInitialization');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { startOfDayGMT7 } = require('../helpers/timezone');
const { ajustarInventario, anularAjuste } = require('../helpers/ajusteInventario');
const router = express.Router();

// @route   POST /api/inventario/inicializar-fifo
// @desc    Abre el inventario FIFO: una capa 'inventario_inicial' por producto con stock y sin capas.
//
// Reescrito (Etapa 2):
// - Una transacción POR PRODUCTO: un error en un producto ya no anula a los demás.
//   El stock se lee dentro de la transacción, así que una venta simultánea no lo desincroniza.
// - Idempotente: se omite cualquier producto que ya tenga capas activas, sin importar
//   fifoInitialized. Los productos con fifoInitialized=true y sin capas (estado real de
//   producción) sí se inicializan (F14). Se puede correr las veces que haga falta.
// - Costo: Producto.cost marcado como 'costo_capturado' (estimado). Sin costo válido se crea la
//   capa a $0 con 'sin_costo' para no bloquear la venta; los reportes deben marcarlo sin costo.
// - El lock siempre se libera (F13: el finally anterior usaba una variable inexistente).
// - receivedDate = inicio del día de Tepic: la apertura queda antes que las compras del mismo día.
router.post('/inicializar-fifo', authenticateToken, requireAdmin, async (req, res) => {
  const LOCK_TIMEOUT_MS = 30 * 60 * 1000;
  const { skus } = req.body || {};
  const lockOwnerId = `${req.user._id}-${Date.now()}`;
  const ahora = new Date();

  // Lock atómico: solo se toma si no hay otro vigente.
  await FIFOInitialization.updateOne(
    { identifier: 'global' },
    { $setOnInsert: { identifier: 'global', status: 'pending', attemptCount: 0 } },
    { upsert: true }
  );
  const init = await FIFOInitialization.findOneAndUpdate(
    {
      identifier: 'global',
      $or: [{ lockOwnerId: null }, { lockOwnerId: { $exists: false } }, { lockExpiresAt: { $lt: ahora } }]
    },
    {
      $set: { status: 'in_progress', user: req.user._id, lastAttemptDate: ahora, lockOwnerId, lockExpiresAt: new Date(Date.now() + LOCK_TIMEOUT_MS) },
      $inc: { attemptCount: 1 }
    },
    { new: true }
  );
  if (!init) {
    const actual = await FIFOInitialization.findOne({ identifier: 'global' });
    return res.status(409).json({ success: false, message: 'Ya existe una inicialización en progreso', lockExpiresAt: actual && actual.lockExpiresAt });
  }

  const resumen = { productsSuccess: 0, productsSkipped: 0, productsFailed: 0, layersCreated: 0, movementsCreated: 0 };
  const errores = [];
  const sinCosto = [];
  let errorGeneral = null;

  try {
    const filtro = { isActive: { $ne: false }, isDeleted: { $ne: true } };
    if (Array.isArray(skus) && skus.length > 0) filtro.sku = { $in: skus };
    const ids = await Producto.find(filtro).distinct('_id');
    const receivedDate = startOfDayGMT7(ahora);

    for (let i = 0; i < ids.length; i++) {
      if (i % 25 === 0) {
        await FIFOInitialization.updateOne(
          { identifier: 'global', lockOwnerId },
          { lockExpiresAt: new Date(Date.now() + LOCK_TIMEOUT_MS), lastAttemptDate: new Date() }
        );
      }
      const session = await mongoose.startSession();
      try {
        let resultado = 'omitido';
        let productoSinCosto = null;
        await session.withTransaction(async () => {
          resultado = 'omitido';
          productoSinCosto = null;
          const producto = await Producto.findById(ids[i]).session(session);
          if (!producto || !(producto.stock > 0)) return;
          const tieneCapas = await InventoryLayer.exists({ producto: producto._id, isActive: true }).session(session);
          if (tieneCapas) {
            if (!producto.fifoInitialized) {
              await Producto.updateOne({ _id: producto._id }, { fifoInitialized: true, fifoInitializationDate: ahora }, { session });
            }
            return;
          }
          const costoValido = typeof producto.cost === 'number' && producto.cost > 0;
          const unitCost = costoValido ? producto.cost : 0;
          const costSource = costoValido ? 'costo_capturado' : 'sin_costo';
          const totalCost = Math.round(unitCost * producto.stock * 100) / 100;
          await InventoryLayer.create([{
            producto: producto._id,
            quantity: producto.stock,
            initialQuantity: producto.stock,
            remainingQuantity: producto.stock,
            unitCost,
            totalCost,
            costSource,
            source: 'inventario_inicial',
            isInitialLayer: true,
            initializationDate: ahora,
            receivedDate,
            notes: costoValido ? 'Apertura FIFO: costo capturado del producto (estimado)' : 'Apertura FIFO: producto sin costo capturado'
          }], { session });
          await InventoryMovement.create([{
            producto: producto._id,
            type: 'entrada',
            quantity: producto.stock,
            unitCost,
            totalCost,
            source: 'inventario_inicial',
            date: receivedDate,
            user: req.user._id,
            movementId: uuidv4(),
            notes: `Apertura de inventario FIFO (${costSource})`
          }], { session });
          await Producto.updateOne({ _id: producto._id }, { fifoInitialized: true, fifoInitializationDate: ahora }, { session });
          resultado = 'creado';
          if (!costoValido) productoSinCosto = { product: producto._id, productName: producto.name, sku: producto.sku, stock: producto.stock };
        });
        if (resultado === 'omitido') {
          resumen.productsSkipped++;
        } else {
          resumen.productsSuccess++;
          resumen.layersCreated++;
          resumen.movementsCreated++;
          if (productoSinCosto) sinCosto.push(productoSinCosto);
        }
      } catch (e) {
        resumen.productsFailed++;
        errores.push({ product: ids[i], error: e.message });
      } finally {
        await session.endSession();
      }
    }

    const status = errores.length === 0 ? 'completed' : (resumen.productsSuccess > 0 ? 'partial' : 'failed');
    await FIFOInitialization.updateOne({ identifier: 'global', lockOwnerId }, {
      $set: {
        status,
        productsTotal: ids.length,
        productsWithErrors: errores,
        notes: sinCosto.length ? `${sinCosto.length} producto(s) abiertos con costo $0 (sin costo capturado)` : '',
        ...(status === 'completed' && { initializationDate: init.initializationDate || ahora, completedAt: new Date() })
      },
      $inc: {
        productsSuccess: resumen.productsSuccess,
        productsFailed: resumen.productsFailed,
        productsSkipped: resumen.productsSkipped,
        layersCreated: resumen.layersCreated,
        movementsCreated: resumen.movementsCreated
      }
    });

    res.json({
      success: true,
      message: status === 'completed' ? 'Inicialización FIFO completada' : `Inicialización FIFO con estado: ${status}`,
      data: { status, productsTotal: ids.length, ...resumen, sinCosto, errors: errores }
    });
  } catch (e) {
    errorGeneral = e;
    console.error('Error en inicialización FIFO:', e);
    res.status(500).json({ success: false, message: 'Error al inicializar inventario FIFO', error: e.message });
  } finally {
    // Siempre liberar el lock (F13).
    try {
      const set = { lockOwnerId: null, lockExpiresAt: null };
      if (errorGeneral) Object.assign(set, { status: 'failed', notes: errorGeneral.message });
      await FIFOInitialization.updateOne({ identifier: 'global', lockOwnerId }, { $set: set });
    } catch (e) {
      console.error('Error al liberar lock de inicialización FIFO:', e);
    }
  }
});

// @route   GET /api/inventario/estado-fifo
// @desc    Obtener estado de inicialización FIFO
router.get('/estado-fifo', authenticateToken, async (req, res) => {
  try {
    const initialization = await FIFOInitialization.findOne({ identifier: 'global' });
    
    if (!initialization) {
      return res.json({
        success: true,
        data: {
          status: 'pending',
          exists: false
        }
      });
    }
    
    res.json({
      success: true,
      data: {
        exists: true,
        status: initialization.status,
        initializationDate: initialization.initializationDate,
        lastAttemptDate: initialization.lastAttemptDate,
        attemptCount: initialization.attemptCount,
        productsProcessed: initialization.productsProcessed,
        productsTotal: initialization.productsTotal,
        productsSuccess: initialization.productsSuccess,
        productsFailed: initialization.productsFailed,
        productsSkipped: initialization.productsSkipped,
        layersCreated: initialization.layersCreated,
        movementsCreated: initialization.movementsCreated,
        completedAt: initialization.completedAt,
        errors: initialization.productsWithErrors
      }
    });
  } catch (error) {
    console.error('Error al obtener estado FIFO:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener estado FIFO'
    });
  }
});

// @route   GET /api/inventario/verificar-consistencia
// @desc    Verificar consistencia entre Producto.stock y capas FIFO
router.get('/verificar-consistencia', authenticateToken, async (req, res) => {
  try {
    const productos = await Producto.find({ 
      isActive: true, 
      isDeleted: false 
    }).select('_id name sku stock fifoInitialized');
    
    const inconsistencias = [];
    
    for (const producto of productos) {
      if (!producto.fifoInitialized) {
        continue;
      }
      
      // Sumar remainingQuantity de capas activas
      const layers = await InventoryLayer.find({
        producto: producto._id,
        isActive: true,
        isExhausted: false
      });
      
      const fifoStock = layers.reduce((sum, layer) => sum + layer.remainingQuantity, 0);
      
      if (Math.abs(producto.stock - fifoStock) > 0.01) {
        inconsistencias.push({
          producto: producto._id,
          productName: producto.name,
          sku: producto.sku,
          stockCatalogo: producto.stock,
          stockFIFO: fifoStock,
          diferencia: producto.stock - fifoStock
        });
      }
    }
    
    res.json({
      success: true,
      data: {
        productosAnalizados: productos.length,
        inconsistencias,
        hayInconsistencias: inconsistencias.length > 0
      }
    });
  } catch (error) {
    console.error('Error al verificar consistencia:', error);
    res.status(500).json({
      success: false,
      message: 'Error al verificar consistencia'
    });
  }
});

// @route   POST /api/inventario/ajustes
// @desc    Ajuste manual de inventario (merma, conteo físico, uso interno, sobrante). Solo admin.
//          Body: { producto, tipo: 'entrada'|'salida', cantidad, motivo, notas?, costoUnitario?,
//                  stockEsperado?, stockContado? }
router.post('/ajustes', authenticateToken, requireAdmin, async (req, res) => {
  const { producto, tipo, cantidad, motivo, notas, costoUnitario, stockEsperado, stockContado } = req.body;
  const session = await mongoose.startSession();
  try {
    let resultado;
    await session.withTransaction(async () => {
      resultado = await ajustarInventario({
        productoId: producto, tipo, cantidad, motivo, notas, costoUnitario, stockEsperado, stockContado, userId: req.user._id
      }, session);
    });
    res.status(201).json({
      success: true,
      message: `Ajuste registrado: stock de ${resultado.stockAntes} a ${resultado.stockDespues}`,
      data: resultado
    });
  } catch (error) {
    if (!error.httpStatus) console.error('Error en ajuste de inventario:', error);
    res.status(error.httpStatus || 500).json({ success: false, message: error.httpStatus ? error.message : 'Error al registrar el ajuste' });
  } finally {
    await session.endSession();
  }
});

// @route   GET /api/inventario/ajustes
// @desc    Historial de ajustes manuales (más recientes primero). Query: producto?, limit?
router.get('/ajustes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    // Las anulaciones no se listan aparte: se muestran como estado del ajuste original
    const filtro = { source: 'ajuste', type: { $in: ['ajuste_entrada', 'ajuste_salida'] }, originalMovement: null };
    if (req.query.producto && mongoose.isValidObjectId(req.query.producto)) filtro.producto = req.query.producto;
    const ajustes = await InventoryMovement.find(filtro)
      .sort({ date: -1, _id: -1 }).limit(limit)
      .populate('producto', 'name sku')
      .populate('user', 'name')
      .select('producto type quantity unitCost totalCost adjustmentReason notes date user stockAntes stockContado')
      .lean();
    const anulaciones = await InventoryMovement.find({ originalMovement: { $in: ajustes.map(a => a._id) }, source: 'ajuste' })
      .populate('user', 'name').select('originalMovement date user notes').lean();
    const porOriginal = new Map(anulaciones.map(a => [String(a.originalMovement), a]));
    res.json({
      success: true,
      data: ajustes.map(a => {
        const an = porOriginal.get(String(a._id));
        return { ...a, anulado: an ? { fecha: an.date, usuario: an.user?.name || null, nota: an.notes || '' } : null };
      })
    });
  } catch (error) {
    console.error('Error al obtener ajustes:', error);
    res.status(500).json({ success: false, message: 'Error al obtener los ajustes' });
  }
});

// @route   DELETE /api/inventario/ajustes/:id
// @desc    Anula un ajuste (no lo borra): registra el movimiento inverso y regresa el stock. Solo admin.
router.delete('/ajustes/:id', authenticateToken, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Identificador inválido' });
  const session = await mongoose.startSession();
  try {
    let r;
    await session.withTransaction(async () => {
      r = await anularAjuste({ movimientoId: req.params.id, userId: req.user._id, nota: 'Ajuste eliminado (anulado)' }, session);
    });
    res.json({ success: true, message: `Ajuste anulado: stock de ${r.stockAntes} a ${r.stockDespues}`, data: r });
  } catch (error) {
    if (!error.httpStatus) console.error('Error al anular ajuste:', error);
    res.status(error.httpStatus || 500).json({ success: false, message: error.httpStatus ? error.message : 'Error al anular el ajuste' });
  } finally {
    await session.endSession();
  }
});

// @route   PUT /api/inventario/ajustes/:id
// @desc    Corrige un ajuste: anula el original y registra el corregido, en una sola transacción.
//          Body: igual que POST (producto, tipo, cantidad, motivo, notas?, costoUnitario?, stockEsperado?, stockContado?).
//          stockEsperado es el stock que tendría el producto SIN el ajuste original.
router.put('/ajustes/:id', authenticateToken, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Identificador inválido' });
  const { producto, tipo, cantidad, motivo, notas, costoUnitario, stockEsperado, stockContado } = req.body;
  const session = await mongoose.startSession();
  try {
    let anulacion; let nuevo;
    await session.withTransaction(async () => {
      anulacion = await anularAjuste({ movimientoId: req.params.id, userId: req.user._id, nota: 'Ajuste corregido (editado)' }, session);
      nuevo = await ajustarInventario({
        productoId: producto, tipo, cantidad, motivo, notas, costoUnitario, stockEsperado, stockContado, userId: req.user._id
      }, session);
    });
    res.json({
      success: true,
      message: `Ajuste corregido: stock de ${anulacion.stockAntes} a ${nuevo.stockDespues}`,
      data: { ...nuevo, anulacion }
    });
  } catch (error) {
    if (!error.httpStatus) console.error('Error al corregir ajuste:', error);
    res.status(error.httpStatus || 500).json({ success: false, message: error.httpStatus ? error.message : 'Error al corregir el ajuste' });
  } finally {
    await session.endSession();
  }
});

module.exports = router;

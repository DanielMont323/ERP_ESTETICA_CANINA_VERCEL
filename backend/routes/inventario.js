const express = require('express');
const mongoose = require('mongoose');
const Producto = require('../models/Producto');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const FIFOInitialization = require('../models/FIFOInitialization');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// @route   POST /api/inventario/inicializar-fifo
// @desc    Inicializar el inventario FIFO una sola vez (modo full o continue)
router.post('/inicializar-fifo', authenticateToken, requireAdmin, async (req, res) => {
  const { mode = 'full' } = req.query; // 'full' o 'continue'
  const { skus } = req.body; // Array de SKUs específicos para pruebas (opcional)

  // Constante de timeout para locks abandonados (30 minutos)
  const LOCK_TIMEOUT_MINUTES = 30;
  const lockOwnerId = req.user._id.toString() + '-' + Date.now();
  let transactionCommitted = false;

  // Helper: renovar lock (heartbeat)
  const renewLock = async () => {
    try {
      const result = await FIFOInitialization.updateOne(
        { identifier: 'global', lockOwnerId: lockOwnerId, status: 'in_progress' },
        { lastAttemptDate: new Date(), lockExpiresAt: new Date(Date.now() + LOCK_TIMEOUT_MINUTES * 60 * 1000) }
      );
      return result.modifiedCount > 0;
    } catch (error) {
      console.error('Error al renovar lock:', error);
      return false;
    }
  };

  // Helper: verificar ownership del lock
  const verifyLockOwnership = async () => {
    const init = await FIFOInitialization.findOne({ identifier: 'global' });
    return init && init.lockOwnerId === lockOwnerId && init.status === 'in_progress';
  };

  // Paso 1: Verificar y recuperar locks abandonados (solo si expiró SIN ser nuestro lock)
  const existingInit = await FIFOInitialization.findOne({ identifier: 'global' });
  if (existingInit && existingInit.status === 'in_progress') {
    const timeSinceAttempt = Date.now() - new Date(existingInit.lastAttemptDate).getTime();
    const timeoutMs = LOCK_TIMEOUT_MINUTES * 60 * 1000;

    // Solo recuperar si expiró Y no es nuestro lock
    if (timeSinceAttempt > timeoutMs && existingInit.lockOwnerId !== lockOwnerId) {
      await FIFOInitialization.updateOne(
        { identifier: 'global', status: 'in_progress', lockOwnerId: existingInit.lockOwnerId },
        {
          status: 'failed',
          notes: `Lock recuperado por timeout (${LOCK_TIMEOUT_MINUTES} minutos excedido sin actividad)`,
          lockOwnerId: null,
          lockExpiresAt: null
        }
      );
    } else if (existingInit.lockOwnerId && existingInit.lockOwnerId !== lockOwnerId) {
      // Lock no expirado, verificar si pertenece a esta solicitud
      if (existingInit.lockOwnerId && existingInit.lockOwnerId !== lockOwnerId) {
        return res.status(409).json({
          success: false,
          message: 'Ya existe una inicialización en progreso',
          lastAttemptDate: existingInit.lastAttemptDate,
          lockExpiresAt: existingInit.lockExpiresAt
        });
      }
    }
  }

  // Paso 2: Adquirir lock atómico FUERA de transacción
  const lockExpiresAt = new Date(Date.now() + LOCK_TIMEOUT_MINUTES * 60 * 1000);

  // Primero verificar si existe documento
  const existingDoc = await FIFOInitialization.findOne({ identifier: 'global' });

  let initialization;
  if (!existingDoc) {
    // No existe, crear nuevo con upsert
    initialization = await FIFOInitialization.create({
      identifier: 'global',
      status: 'in_progress',
      user: req.user._id,
      lastAttemptDate: new Date(),
      lockOwnerId: lockOwnerId,
      lockExpiresAt: lockExpiresAt,
      attemptCount: 1
    });
  } else if (existingDoc.status !== 'in_progress') {
    // Existe pero no está en progreso, actualizar
    initialization = await FIFOInitialization.findOneAndUpdate(
      { identifier: 'global', _id: existingDoc._id },
      {
        status: 'in_progress',
        user: req.user._id,
        lastAttemptDate: new Date(),
        lockOwnerId: lockOwnerId,
        lockExpiresAt: lockExpiresAt,
        $inc: { attemptCount: 1 }
      },
      { new: true }
    );
  } else {
    // Está en progreso, verificar si es nuestro lock o está expirado
    const timeSinceAttempt = Date.now() - new Date(existingDoc.lastAttemptDate).getTime();
    const timeoutMs = LOCK_TIMEOUT_MINUTES * 60 * 1000;

    if (timeSinceAttempt > timeoutMs && existingDoc.lockOwnerId !== lockOwnerId) {
      // Lock expirado y no es nuestro, recuperar
      initialization = await FIFOInitialization.findOneAndUpdate(
        { identifier: 'global', _id: existingDoc._id },
        {
          status: 'in_progress',
          user: req.user._id,
          lastAttemptDate: new Date(),
          lockOwnerId: lockOwnerId,
          lockExpiresAt: lockExpiresAt,
          $inc: { attemptCount: 1 }
        },
        { new: true }
      );
    } else if (existingDoc.lockOwnerId === lockOwnerId) {
      // Es nuestro lock, reutilizar y renovar
      initialization = existingDoc;
      await renewLock();
    } else {
      // Lock pertenece a otro y no expiró
      return res.status(409).json({
        success: false,
        message: 'Ya existe una inicialización en progreso',
        lastAttemptDate: existingDoc.lastAttemptDate,
        lockExpiresAt: existingDoc.lockExpiresAt
      });
    }
  }

  // Si no se pudo adquirir el lock
  if (!initialization) {
    const currentInit = await FIFOInitialization.findOne({ identifier: 'global' });
    return res.status(409).json({
      success: false,
      message: 'Ya existe una inicialización en progreso',
      lastAttemptDate: currentInit?.lastAttemptDate,
      lockExpiresAt: currentInit?.lockExpiresAt
    });
  }

  // Verificar si ya está completado (modo full y sin skus específicos)
  if (mode === 'full' && !skus && initialization.status === 'completed') {
    // Liberar el lock (solo si pertenece a esta solicitud)
    if (initialization.lockOwnerId === lockOwnerId) {
      await FIFOInitialization.updateOne(
        { identifier: 'global', lockOwnerId: lockOwnerId },
        {
          status: 'completed',
          lockOwnerId: null,
          lockExpiresAt: null
        }
      );
    }
    return res.status(400).json({
      success: false,
      message: 'El inventario FIFO ya fue inicializado completamente',
      initializationDate: initialization.initializationDate
    });
  }

  // Paso 2: Iniciar transacción para la operación principal
  const session = await mongoose.startSession();
  session.startTransaction();

  try {

    // Obtener productos según modo
    let productos;
    if (skus && Array.isArray(skus) && skus.length > 0) {
      // Modo prueba con SKUs específicos
      if (mode === 'continue') {
        // En modo continue, filtrar SKUs por los que no tienen capas iniciales
        const allProductos = await Producto.find({
          sku: { $in: skus },
          isActive: true,
          isDeleted: false
        }).select('_id name sku cost stock');

        // Filtrar solo los que no tienen capas iniciales
        const productosIds = allProductos.map(p => p._id);
        const existingLayers = await InventoryLayer.find({
          producto: { $in: productosIds },
          source: 'inventario_inicial',
          isInitialLayer: true
        }).select('producto').session(session);

        const productosWithLayers = new Set(existingLayers.map(l => l.producto.toString()));
        productos = allProductos.filter(p => !productosWithLayers.has(p._id.toString()));
      } else {
        // Modo full: todos los SKUs especificados
        productos = await Producto.find({
          sku: { $in: skus },
          isActive: true,
          isDeleted: false
        }).select('_id name sku cost stock');
      }
    } else if (mode === 'continue') {
      // Solo productos que fallaron o no fueron procesados
      const processedIds = initialization.productsProcessedIds || [];
      productos = await Producto.find({
        isActive: true,
        isDeleted: false,
        _id: { $nin: processedIds }
      }).select('_id name sku cost stock');
    } else {
      // Todos los productos activos
      productos = await Producto.find({
        isActive: true,
        isDeleted: false
      }).select('_id name sku cost stock');
    }

    // Solo actualizar productsTotal si no está ya seteado
    if (initialization.productsTotal === undefined || initialization.productsTotal === 0) {
      initialization.productsTotal = await Producto.countDocuments({
        isActive: true,
        isDeleted: false
      });
    }
    await initialization.save({ session });
    
    const errors = [];
    let layersCreated = 0;
    let movementsCreated = 0;
    let productsSuccess = 0;
    let productsFailed = 0;
    let productsSkipped = 0;
    const processedThisAttempt = [];
    
    // Procesar cada producto
    for (const producto of productos) {
      try {
        // Validar que tenga costo válido
        if (!producto.cost || producto.cost < 0) {
          errors.push({
            product: producto._id,
            productName: producto.name,
            sku: producto.sku,
            error: 'Costo inválido',
            reason: `Costo: ${producto.cost}`
          });
          productsFailed++;
          continue;
        }
        
        // Validar que tenga stock positivo
        if (!producto.stock || producto.stock <= 0) {
          // Productos sin stock no se inicializan pero no es error
          productsSkipped++;
          continue;
        }
        
        // Verificar si ya fue inicializado (idempotencia)
        if (producto.fifoInitialized) {
          productsSkipped++; // Marcar como omitido ya que ya estaba inicializado
          continue;
        }

        // Verificar si ya existe capa de inventario inicial (idempotencia doble)
        const existingLayer = await InventoryLayer.findOne({
          producto: producto._id,
          source: 'inventario_inicial',
          isInitialLayer: true
        }).session(session);

        if (existingLayer) {
          // Ya existe capa, marcar producto como inicializado pero no crear nueva capa
          await Producto.findByIdAndUpdate(
            producto._id,
            {
              fifoInitialized: true,
              fifoInitializationDate: existingLayer.initializationDate || new Date()
            },
            { session }
          );
          productsSkipped++; // Marcar como omitido ya que ya tenía capa
          continue;
        }
        
        // Calcular costo total de la capa
        const totalCost = producto.stock * producto.cost;
        
        // Crear capa de inventario inicial
        const layer = new InventoryLayer({
          producto: producto._id,
          quantity: producto.stock,
          initialQuantity: producto.stock,
          unitCost: producto.cost,
          totalCost: totalCost,
          source: 'inventario_inicial',
          isInitialLayer: true,
          initializationDate: new Date(),
          receivedDate: new Date(),
          remainingQuantity: producto.stock
        });
        
        await layer.save({ session });
        layersCreated++;
        
        // Crear movimiento de inventario inicial
        const movement = new InventoryMovement({
          producto: producto._id,
          type: 'entrada',
          quantity: producto.stock,
          unitCost: producto.cost,
          totalCost: totalCost,
          source: 'inventario_inicial',
          date: new Date(),
          user: req.user._id,
          notes: 'Apertura de inventario FIFO'
        });
        
        await movement.save({ session });
        movementsCreated++;
        
        // Marcar producto como inicializado
        await Producto.findByIdAndUpdate(
          producto._id,
          {
            fifoInitialized: true,
            fifoInitializationDate: new Date()
          },
          { session }
        );
        
        processedThisAttempt.push(producto._id);
        productsSuccess++;
        
      } catch (error) {
        errors.push({
          product: producto._id,
          productName: producto.name,
          sku: producto.sku,
          error: error.message,
          reason: 'Error al procesar producto'
        });
        productsFailed++;
      }
    }
    
    // Actualizar registro de inicialización
    const allProcessedIds = [...(initialization.productsProcessedIds || []), ...processedThisAttempt];
    initialization.productsProcessedIds = allProcessedIds;
    initialization.productsProcessed = allProcessedIds.length;
    initialization.productsSuccess = (initialization.productsSuccess || 0) + productsSuccess;
    initialization.productsFailed = (initialization.productsFailed || 0) + productsFailed;
    initialization.productsSkipped = (initialization.productsSkipped || 0) + productsSkipped;
    initialization.layersCreated = (initialization.layersCreated || 0) + layersCreated;
    initialization.movementsCreated = (initialization.movementsCreated || 0) + movementsCreated;
    initialization.productsWithErrors = errors;
    
    // Determinar status final
    if (errors.length > 0 && productsSuccess > 0) {
      initialization.status = 'partial';
    } else if (errors.length > 0) {
      initialization.status = 'failed';
    } else {
      initialization.status = 'completed';
      initialization.initializationDate = new Date();
      initialization.completedAt = new Date();
    }
    
    await initialization.save({ session });
    
    await session.commitTransaction();
    transactionCommitted = true;

    res.json({
      success: true,
      message: initialization.status === 'completed' 
        ? 'Inicialización FIFO completada exitosamente'
        : `Inicialización FIFO completada con status: ${initialization.status}`,
      data: {
        mode,
        status: initialization.status,
        productsProcessed: initialization.productsProcessed,
        productsTotal: initialization.productsTotal,
        productsSuccess: initialization.productsSuccess,
        productsFailed: initialization.productsFailed,
        productsSkipped: initialization.productsSkipped,
        layersCreated: initialization.layersCreated,
        movementsCreated: initialization.movementsCreated,
        errors: errors,
        initializationDate: initialization.initializationDate,
        attemptCount: initialization.attemptCount
      }
    });
    
  } catch (error) {
    await session.abortTransaction();

    console.error('Error en inicialización FIFO:', error);
    res.status(500).json({
      success: false,
      message: 'Error al inicializar inventario FIFO',
      error: error.message
    });
  } finally {
    // Asegurar que la sesión se cierre
    if (session) {
      await session.endSession();
    }

    // Actualizar estado del lock en finally
    try {
      const currentInit = await FIFOInitialization.findOne({ identifier: 'global' });
      
      if (currentInit && currentInit.lockOwnerId === lockOwnerId) {
        if (!transactionCommitted) {
          // Transacción no se commitió - marcar como failed si sigue in_progress
          if (currentInit.status === 'in_progress') {
            currentInit.status = 'failed';
            currentInit.notes = error ? error.message : 'Error desconocido';
          }
        }
        // Siempre liberar el lock (tanto en éxito como en fallo)
        currentInit.lockOwnerId = null;
        currentInit.lockExpiresAt = null;
        await currentInit.save();
      }
    } catch (finallyError) {
      console.error('Error al liberar lock en finally:', finallyError);
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

module.exports = router;

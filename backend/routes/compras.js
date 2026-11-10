const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Compra = require('../models/Compra');
const Producto = require('../models/Producto');
const Proveedor = require('../models/Proveedor');
const CuentaPorPagar = require('../models/CuentaPorPagar');
const Recordatorio = require('../models/Recordatorio');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { getCurrentDateGMT7 } = require('../helpers/timezone');
const router = express.Router();

// Helper para parsear fecha YYYY-MM-DD como fecha de calendario (no UTC con timezone)
// Usa la función centralizada de timezone.js para evitar desfase
const { parseCalendarDate } = require('../helpers/timezone');

// ============================================================================
// HELPERS PARA LOCK Y REINTENTOS
// ============================================================================

// Helper para esperar
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper para verificar si un error es transitorio de MongoDB
const isTransientTransactionError = (error) => {
  if (error.name === 'MongoServerError' && error.code === 112) {
    return true; // WriteConflict explícito
  }
  if (error.name === 'MongoTransactionError' && 
      error.errorLabels && 
      error.errorLabels.includes('TransientTransactionError')) {
    return true; // Label de MongoDB
  }
  if (error.message && error.message.includes('WriteConflict')) {
    return true; // En el mensaje de error
  }
  return false;
};

// Adquirir lock atómicamente sobre una compra
const acquireLock = async (compraId, lockDurationMs = 30000) => {
  const lockToken = crypto.randomUUID();
  const lockExpiresAt = new Date(Date.now() + lockDurationMs);

  const lockedCompra = await Compra.findOneAndUpdate(
    { 
      _id: compraId,
      $or: [
        { lockToken: { $exists: false } },
        { lockToken: null },
        { lockExpiresAt: { $lt: new Date() } } // Lock expirado
      ]
    },
    {
      lockToken: lockToken,
      lockExpiresAt: lockExpiresAt
    },
    { new: true }
  );

  if (!lockedCompra) {
    return null; // No se pudo adquirir el lock
  }

  return lockToken;
};

// Liberar lock condicionado al propietario
const releaseLock = async (compraId, lockToken) => {
  await Compra.findOneAndUpdate(
    { 
      _id: compraId,
      lockToken: lockToken  // Solo liberar si somos dueños
    },
    {
      $unset: { lockToken: 1, lockExpiresAt: 1 }
    }
  );
};

// Verificar ownership del lock
const verifyLock = async (compraId, lockToken) => {
  const compra = await Compra.findOne({
    _id: compraId,
    lockToken: lockToken
  });
  return compra !== null;
};

// Renovar lock (heartbeat) - extiende la expiración
const renewLock = async (compraId, lockToken, lockDurationMs = 30000) => {
  const lockExpiresAt = new Date(Date.now() + lockDurationMs);

  const renewedCompra = await Compra.findOneAndUpdate(
    { 
      _id: compraId,
      lockToken: lockToken  // Solo renovar si somos dueños
    },
    {
      lockExpiresAt: lockExpiresAt
    },
    { new: true }
  );

  return renewedCompra !== null;
};

// @route   GET /api/compras
// @desc    Obtener todas las compras
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { proveedor, status, sku, type, search, page = 1, limit = 10 } = req.query;
    let query = {};

    if (proveedor) query.proveedor = proveedor;
    if (status) query.status = status;
    if (type) query.type = type;

    // Búsqueda por folio, proveedor o factura con prioridad de coincidencia exacta
    if (search) {
      const proveedores = await Proveedor.find({ name: { $regex: search, $options: 'i' } }).select('_id');
      const proveedorIds = proveedores.map(p => p._id);
      
      // Prioridad: coincidencia exacta en receiptNumber
      const exactMatch = await Compra.find({
        receiptNumber: search
      }).select('_id');
      
      if (exactMatch.length > 0) {
        // Si hay coincidencia exacta, buscar solo esas compras
        query._id = { $in: exactMatch.map(c => c._id) };
      } else {
        // Si no hay coincidencia exacta, buscar parcial
        query.$or = [
          { receiptNumber: { $regex: search, $options: 'i' } },
          { invoice: { $regex: search, $options: 'i' } },
          { proveedor: { $in: proveedorIds } }
        ];
      }
    }

    // Filtro por SKU (busca en items de la compra)
    if (sku) {
      // Buscar productos que coincidan con el SKU
      const productos = await Producto.find({ 
        sku: { $regex: sku, $options: 'i' } 
      }).select('_id');
      
      const productoIds = productos.map(p => p._id);
      
      if (productoIds.length > 0) {
        query['items.product'] = { $in: productoIds };
      } else {
        // Si no hay productos con ese SKU, retornar vacío
        return res.json({
          success: true,
          data: [],
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: 0,
            pages: 0
          }
        });
      }
    }

    const compras = await Compra.find(query)
      .populate('proveedor', 'name contact phone')
      .populate('user', 'name')
      .populate('items.product', 'name sku')
      .sort({ date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Compra.countDocuments(query);

    res.json({
      success: true,
      data: compras,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener compras'
    });
  }
});

// @route   GET /api/compras/:id
// @desc    Obtener compra por ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const compra = await Compra.findById(req.params.id)
      .populate('proveedor', 'name contact phone email creditDays')
      .populate('user', 'name')
      .populate('items.product', 'name sku category');
    
    if (!compra) {
      return res.status(404).json({
        success: false,
        message: 'Compra no encontrada'
      });
    }
    
    res.json({
      success: true,
      data: compra
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener compra'
    });
  }
});

// @route   POST /api/compras
// @desc    Crear nueva compra
router.post('/', authenticateToken, async (req, res) => {
  const { proveedor, items, type, paymentMethod, user, notes, invoice, receiptNumber, hasIVA, ivaRate, date, idempotencyKey } = req.body;

  // Verificar idempotencia si se proporciona
  if (idempotencyKey) {
    const existingCompra = await Compra.findOne({ idempotencyKey });
    if (existingCompra) {
      // Solo retornar resultado existente si la compra fue exitosa (no cancelada)
      if (existingCompra.status !== 'cancelada') {
        await existingCompra.populate('proveedor', 'name contact phone');
        await existingCompra.populate('user', 'name');
        await existingCompra.populate('items.product', 'name sku');
        
        return res.status(200).json({
          success: true,
          message: 'Compra ya procesada (idempotencia)',
          data: existingCompra,
          idempotent: true
        });
      }
      // Si fue cancelada, permitir reintentar (la compra falló)
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validar que haya items
    if (!items || items.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'La compra debe tener al menos un item'
      });
    }

    // Verificar que el proveedor exista
    const proveedorDoc = await Proveedor.findById(proveedor).session(session);
    if (!proveedorDoc) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: 'Proveedor no encontrado'
      });
    }

    const SupplierProduct = require('../models/SupplierProduct');

    // Procesar items con autocompletado de descuentos
    const processedItems = [];
    for (const item of items) {
      const producto = await Producto.findById(item.product).session(session);
      if (!producto) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({
          success: false,
          message: `Producto con ID ${item.product} no encontrado`
        });
      }

      // Buscar condiciones de descuento para este proveedor y producto
      const supplierProduct = await SupplierProduct.findOne({
        supplier: proveedor,
        product: item.product,
        isActive: true
      }).session(session);

      // Calcular baseUnitCost y unitCost según si el costo incluye IVA
      let baseUnitCost;
      let unitCostToSave;

      if (item.costIncludesTax === true) {
        // IVA incluido: desglosar
        const totalWithTax = Number(item.unitCost) || 0;
        const taxRate = Number(item.taxRate) || 0.16;
        baseUnitCost = totalWithTax / (1 + taxRate);
        unitCostToSave = totalWithTax;
      } else {
        // IVA no incluido: comportamiento actual
        baseUnitCost = item.unitCost || (supplierProduct?.baseCost || producto.cost);
        unitCostToSave = baseUnitCost;
      }
      
      // Autocompletar condiciones de descuento
      const processedItem = {
        product: item.product,
        quantity: item.quantity,
        baseUnitCost: baseUnitCost,
        unitCost: unitCostToSave,
        discountPercentage: supplierProduct?.discountPercentage || 0,
        discountDays: supplierProduct?.discountDays || 0,
        discountApplied: false,
        hasTax: item.hasTax !== undefined ? item.hasTax : true,
        taxRate: item.taxRate !== undefined ? item.taxRate : 0.16,
        costIncludesTax: item.costIncludesTax || false
      };

      processedItems.push(processedItem);

      // Actualizar stock y costo del producto
      producto.stock += item.quantity;
      producto.cost = baseUnitCost;
      await producto.save({ session });
    }

    // Calcular fecha de vencimiento para compras a crédito
    let dueDate;
    let earlyPaymentDiscount = 0;
    let discountDeadline;
    
    if (type === 'credito') {
      // Usar la fecha de compra proporcionada por el usuario, o la fecha actual si no se especifica
      const { getCurrentDateGMT7 } = require('../helpers/timezone');
      const purchaseDate = date ? parseCalendarDate(date) : getCurrentDateGMT7();
      
      dueDate = new Date(purchaseDate);
      dueDate.setDate(dueDate.getDate() + proveedorDoc.creditDays);
      
      // Aplicar descuento por pronto pago del proveedor
      earlyPaymentDiscount = proveedorDoc.earlyPaymentDiscount || 0;
      
      // Establecer fecha límite de descuento (misma que fecha de vencimiento)
      if (earlyPaymentDiscount > 0) {
        discountDeadline = new Date(purchaseDate);
        discountDeadline.setDate(discountDeadline.getDate() + proveedorDoc.creditDays);
      }
    }

    // Crear compra con items procesados
    const compra = await Compra.create([{
      proveedor,
      items: processedItems,
      type,
      paymentMethod: type === 'contado' ? paymentMethod : undefined,
      dueDate,
      user,
      notes,
      invoice,
      earlyPaymentDiscount,
      discountDeadline,
      idempotencyKey: idempotencyKey || null,
      // Usar fecha personalizada si se proporciona, si no usa el default del modelo
      ...(date && { date: parseCalendarDate(date) })
    }], { session });

    // Crear capas FIFO y movimientos después de crear la compra
    for (let i = 0; i < processedItems.length; i++) {
      const item = processedItems[i];
      const itemIndex = i;

      // Verificar si ya existe capa para esta compra y item (protección contra duplicados)
      const existingLayer = await InventoryLayer.findOne({
        purchase: compra[0]._id,
        compraItemIndex: itemIndex,
        producto: item.product
      }).session(session);

      if (!existingLayer) {
        // Calcular costo unitario FIFO según fórmula aprobada
        // Subtotal base = cantidad × costo base unitario
        const baseSubtotal = item.quantity * item.baseUnitCost;
        
        // Descuento comercial = subtotal base × porcentaje de descuento
        const discountAmount = baseSubtotal * (item.discountPercentage / 100);
        
        // Subtotal neto = subtotal base − descuento comercial
        const subtotalNeto = baseSubtotal - discountAmount;
        
        // IVA = subtotal neto × tasa de IVA, cuando corresponda
        const itemTax = (item.hasTax !== false) ? (subtotalNeto * (item.taxRate || 0.16)) : 0;
        
        // Costo total FIFO = subtotal neto + IVA
        const costoTotalFIFO = subtotalNeto + itemTax;
        
        // Costo unitario FIFO = costo total FIFO / cantidad
        const costoUnitarioFIFO = costoTotalFIFO / item.quantity;

        // Crear capa FIFO con purchase._id real
        const layer = new InventoryLayer({
          producto: item.product,
          purchase: compra[0]._id,
          compraItemIndex: itemIndex,
          compraVersion: 1,
          quantity: item.quantity,
          initialQuantity: item.quantity,
          remainingQuantity: item.quantity,
          unitCost: costoUnitarioFIFO,
          totalCost: costoTotalFIFO,
          source: 'compra',
          purchase: compra[0]._id,
          compraItemIndex: itemIndex,
          supplier: proveedor,
          isInitialLayer: false,
          receivedDate: date ? parseCalendarDate(date) : getCurrentDateGMT7(),
          remainingQuantity: item.quantity
        });
        await layer.save({ session });

        // Crear movimiento de inventario con sourceId real
        const movement = new InventoryMovement({
          producto: item.product,
          type: 'entrada',
          quantity: item.quantity,
          unitCost: costoUnitarioFIFO,
          totalCost: costoTotalFIFO,
          source: 'compra',
          sourceId: compra[0]._id,
          sourceItemIndex: itemIndex,
          sourceVersion: 1,
          date: date ? parseCalendarDate(date) : getCurrentDateGMT7(),
          user: user,
          notes: `Compra ${receiptNumber || 'N/A'}`
        });
        await movement.save({ session });
      }
    }

    // Si es a crédito, crear cuenta por pagar
    if (type === 'credito') {
      try {
        // Calcular IVA total desde los items de la compra
        const totalIVA = compra[0].totalIVA || 0;
        const totalConIVA = compra[0].total || compra[0].baseTotal;

        // Verificar si ya existe una cuenta por pagar para esta compra
        const existingAccount = await CuentaPorPagar.findOne({ compra: compra[0]._id }).session(session);
        if (existingAccount) {
          console.log(`Cuenta por pagar ya existe para compra ${compra[0]._id}, no se crea duplicado`);
        } else {
          // Calcular el saldo inicial basado en el importe exigible (con descuento si aplica)
          const saldoInicial = compra[0].totalDiscount > 0 ? compra[0].total : compra[0].baseTotal;
          
          await CuentaPorPagar.create([{
            proveedor,
            compra: compra[0]._id,
            receiptNumber,
            hasIVA: totalIVA > 0,
            ivaRate: 0.16, // Tasa promedio, el IVA real está en totalIVA
            subtotal: compra[0].baseTotal,
            ivaAmount: totalIVA,
            monto: totalConIVA,
            montoBase: compra[0].baseTotal,
            descuentoDisponible: compra[0].totalDiscount,
            discountDeadline: compra[0].discountDeadline,
            saldo: saldoInicial,
            dueDate,
            notes: `Cuenta generada por compra ${compra[0]._id}`
          }], { session });
          console.log(`Cuenta por pagar creada exitosamente para compra ${compra[0]._id}`);
        }

        // Crear recordatorio automático para el pago
        try {
          await Recordatorio.create([{
            title: `Pago a proveedor - ${proveedorDoc.name}`,
            description: `Pago de cuenta por compra ${receiptNumber || compra[0]._id} por $${totalConIVA.toFixed(2)}`,
            date: dueDate,
            type: 'pago',
            priority: 'alta',
            relatedId: proveedor,
            relatedModel: 'Proveedor',
            status: 'pendiente',
            user: user
          }], { session });
        } catch (reminderError) {
          console.error('Error al crear recordatorio automático:', reminderError);
          // No fallar la compra si falla el recordatorio
        }

        // Actualizar deuda del proveedor con el total con IVA
        proveedorDoc.currentDebt += totalConIVA;
        await proveedorDoc.save({ session });
      } catch (accountError) {
        await session.abortTransaction();
        session.endSession();
        console.error('=== ERROR DETALLADO AL CREAR CUENTA POR PAGAR ===');
        console.error('Error name:', accountError.name);
        console.error('Error message:', accountError.message);
        
        if (accountError.errors) {
          console.error('Campos con error de validación:');
          Object.keys(accountError.errors).forEach(field => {
            console.error(`  Campo ${field}:`, accountError.errors[field].message);
            console.error(`    Valor recibido:`, accountError.errors[field].value);
          });
        }
        
        console.error('Valores enviados a CuentaPorPagar.create():');
        console.error('  proveedor:', proveedor);
        console.error('  compra:', compra[0]._id);
        console.error('  receiptNumber:', receiptNumber);
        console.error('  hasIVA:', totalIVA > 0);
        console.error('  ivaRate:', 0.16);
        console.error('  subtotal:', compra[0].baseTotal);
        console.error('  ivaAmount:', totalIVA);
        console.error('  monto:', totalConIVA);
        console.error('  montoBase:', compra[0].baseTotal);
        console.error('  descuentoDisponible:', compra[0].totalDiscount);
        console.error('  discountDeadline:', compra[0].discountDeadline);
        console.error('  saldo:', saldoInicial);
        console.error('  dueDate:', dueDate);
        console.error('=====================================================');
        
        return res.status(500).json({
          success: false,
          message: 'Error al crear cuenta por pagar.',
          error: accountError.message
        });
      }
    }

    // Commit de la transacción
    await session.commitTransaction();
    session.endSession();

    // Populate para respuesta
    await compra[0].populate('proveedor', 'name contact phone');
    await compra[0].populate('user', 'name');
    await compra[0].populate('items.product', 'name sku');

    res.status(201).json({
      success: true,
      data: compra[0]
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error(error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error al crear compra'
    });
  }
});

// @route   PUT /api/compras/:id
// @desc    Actualizar compra (solo admin) - Protegido con FIFO con reintentos y lock
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { 
    proveedor, 
    items, 
    type, 
    hasIVA, 
    ivaRate, 
    notes, 
    invoice,
    paymentMethod,
    earlyPaymentDiscount,
    discountDeadline,
    dueDate,
    date,
    lastModificationIdempotencyKey
  } = req.body;

  const maxRetries = 3;
  const retryDelay = 100; // ms base
  const lockDurationMs = 30000; // 30 segundos
  const heartbeatIntervalMs = 10000; // Renovar lock cada 10 segundos
  
  let lockToken = null;
  let lockAcquired = false;
  let heartbeatTimer = null;
  let lastError = null;

  try {
    // Paso 0: Verificar idempotencia (antes de adquirir lock)
    if (lastModificationIdempotencyKey) {
      const compraConMismaKey = await Compra.findOne({
        _id: req.params.id,
        lastModificationIdempotencyKey: lastModificationIdempotencyKey
      });

      if (compraConMismaKey) {
        // Esta solicitud es un reintento de una modificación ya procesada
        await compraConMismaKey.populate('proveedor', 'name contact phone');
        await compraConMismaKey.populate('user', 'name');
        await compraConMismaKey.populate('items.product', 'name sku');
        
        return res.status(200).json({
          success: true,
          message: 'Modificación ya procesada (idempotencia)',
          data: compraConMismaKey,
          idempotent: true
        });
      }

      // Verificar si la key pertenece a una versión anterior (rechazar)
      const compraActual = await Compra.findById(req.params.id);
      if (compraActual && compraActual.modificationIdempotencyKeys) {
        const keyEnHistorial = compraActual.modificationIdempotencyKeys.find(k => k.key === lastModificationIdempotencyKey);
        if (keyEnHistorial && keyEnHistorial.version < compraActual.version) {
          return res.status(409).json({
            success: false,
            message: 'La compra ha sido modificada posteriormente. Esta solicitud es obsoleta.'
          });
        }
      }
    }

    // Paso 1: Adquirir lock atómicamente (fuera del loop de reintentos)
    lockToken = await acquireLock(req.params.id, lockDurationMs);
    if (!lockToken) {
      return res.status(409).json({
        success: false,
        message: 'La compra está siendo modificada por otro proceso'
      });
    }
    lockAcquired = true;

    // Iniciar heartbeat para renovar lock periódicamente
    heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await renewLock(req.params.id, lockToken, lockDurationMs);
        if (!renewed) {
          console.log(`Heartbeat: No se pudo renovar lock para compra ${req.params.id}`);
        }
      } catch (err) {
        console.error(`Heartbeat error:`, err);
      }
    }, heartbeatIntervalMs);

    // Paso 2: Loop de reintentos para la transacción
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Verificar ownership antes de iniciar transacción
        const hasOwnership = await verifyLock(req.params.id, lockToken);
        if (!hasOwnership) {
          await session.abortTransaction();
          session.endSession();
          throw new Error('Perdida de lock - otra solicitud modificó la compra');
        }

        const compra = await Compra.findById(req.params.id).session(session);
        if (!compra) {
          await session.abortTransaction();
          session.endSession();
          return res.status(404).json({
            success: false,
            message: 'Compra no encontrada'
          });
        }

        if (compra.status === 'cancelada') {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            success: false,
            message: 'No se puede modificar una compra cancelada'
          });
        }

        // Verificar si la compra está siendo modificada (redundante, status se usa para rollback)
        if (compra.status === 'modificando') {
          await session.abortTransaction();
          session.endSession();
          return res.status(409).json({
            success: false,
            message: 'La compra está siendo modificada por otro proceso'
          });
        }

        // Marcar como modificando
        compra.status = 'modificando';
        await compra.save({ session });

        // Verificar ownership antes de escrituras críticas
        const stillHasOwnership = await verifyLock(req.params.id, lockToken);
        if (!stillHasOwnership) {
          await session.abortTransaction();
          session.endSession();
          throw new Error('Perdida de lock antes de escritura');
        }

        // Verificar si la compra tiene CuentaPorPagar con pagos
        const cuentaPorPagar = await CuentaPorPagar.findOne({ compra: compra._id }).session(session);
        if (cuentaPorPagar && cuentaPorPagar.payments && cuentaPorPagar.payments.length > 0) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            success: false,
            message: 'Esta compra tiene pagos registrados y no puede modificarse'
          });
        }

        // Verificar si la compra tiene capas FIFO
        const layers = await InventoryLayer.find({ purchase: compra._id }).session(session);
        console.log(`[PUT DEBUG] Compra ${req.params.id}: version=${compra.version}, layers=${layers.length}, items=${compra.items.length}`);

        if (layers.length === 0) {
          // Compra antigua sin capas FIFO
          // Verificar si los productos tienen capas de inicialización FIFO
          for (const item of compra.items) {
            const producto = await Producto.findById(item.product).session(session);
            const initialLayers = await InventoryLayer.find({
              producto: item.product,
              source: 'inventario_inicial',
              isActive: true
            }).session(session);

            if (initialLayers.length > 0) {
              await session.abortTransaction();
              session.endSession();
              return res.status(400).json({
                success: false,
                message: 'Esta compra es anterior a FIFO y el producto tiene inventario inicializado. No se puede modificar de forma segura porque no se pueden identificar y revertir los efectos originales de la compra.'
              });
            }
          }

          // Usar lógica antigua (sin FIFO)
          const originalItems = compra.items;
          const originalType = compra.type;
          const originalProveedor = compra.proveedor;

          const getValue = (...values) => {
            for (const val of values) {
              if (val !== undefined && val !== null) return val;
            }
            return 0;
          };

          if (items) {
            const normalizedItems = items.map(item => ({
              ...item,
              baseUnitCost: getValue(item.baseUnitCost, item.cost, item.unitCost),
              unitCost: getValue(item.unitCost, item.cost, item.baseUnitCost),
              quantity: item.quantity || 1,
              discountPercentage: item.discountPercentage || 0,
              hasTax: item.hasTax !== undefined ? item.hasTax : true,
              taxRate: item.taxRate !== undefined ? item.taxRate : 0.16,
              costIncludesTax: item.costIncludesTax || false
            }));

            // Devolver stock de items originales
            for (const originalItem of originalItems) {
              const producto = await Producto.findById(originalItem.product).session(session);
              if (producto) {
                producto.stock -= originalItem.quantity;
                if (producto.stock < 0) producto.stock = 0;
                await producto.save({ session });
              }
            }

            // Verificar y descontar stock de nuevos items
            for (const newItem of normalizedItems) {
              const producto = await Producto.findById(newItem.product).session(session);
              if (!producto) {
                // Revertir stock si no existe producto
                for (const originalItem of originalItems) {
                  const prod = await Producto.findById(originalItem.product).session(session);
                  if (prod) {
                    prod.stock += originalItem.quantity;
                    await prod.save({ session });
                  }
                }
                await session.abortTransaction();
                session.endSession();
                return res.status(404).json({
                  success: false,
                  message: `Producto con ID ${newItem.product} no encontrado`
                });
              }

              producto.stock += newItem.quantity;
              await producto.save({ session });
            }

            compra.items = normalizedItems;
          }

          // Actualizar otros campos
          if (proveedor !== undefined) compra.proveedor = proveedor;
          if (type !== undefined) compra.type = type;
          if (hasIVA !== undefined) compra.hasIVA = hasIVA;
          if (ivaRate !== undefined) compra.ivaRate = ivaRate;
          if (notes !== undefined) compra.notes = notes;
          if (invoice !== undefined) compra.invoice = invoice;
          if (earlyPaymentDiscount !== undefined) compra.earlyPaymentDiscount = earlyPaymentDiscount;
          if (discountDeadline !== undefined) compra.discountDeadline = discountDeadline;
          if (dueDate !== undefined) compra.dueDate = dueDate;
          if (date !== undefined && date !== '') {
            const parsedDate = parseCalendarDate(date);
            if (parsedDate) {
              compra.date = parsedDate;
            }
          }

          // Recalcular totales
          compra.baseTotal = Math.round((compra.items.reduce((sum, item) => {
            const cost = getValue(item.baseUnitCost, item.cost, item.unitCost);
            const qty = item.quantity || 1;
            return sum + (qty * cost);
          }, 0)) * 100) / 100;
          
          compra.totalDiscount = Math.round((compra.items.reduce((sum, item) => {
            const cost = getValue(item.baseUnitCost, item.cost, item.unitCost);
            const qty = item.quantity || 1;
            const discountPct = item.discountPercentage || 0;
            return sum + (qty * cost * (discountPct / 100));
          }, 0)) * 100) / 100;
          
          const totalIVA = Math.round((compra.items.reduce((sum, item) => {
            const cost = getValue(item.baseUnitCost, item.cost, item.unitCost);
            const qty = item.quantity || 1;
            const discountPct = item.discountPercentage || 0;
            const subtotal = (qty * cost) - (qty * cost * (discountPct / 100));
            const itemTax = (item.hasTax !== false) ? (subtotal * (item.taxRate || 0.16)) : 0;
            return sum + itemTax;
          }, 0)) * 100) / 100;
          
          compra.totalIVA = totalIVA;
          compra.total = Math.round((compra.baseTotal - compra.totalDiscount + totalIVA) * 100) / 100;

          await compra.save({ session });

          // Manejo de CuentaPorPagar (lógica antigua)
          if (type === 'credito' && originalType === 'contado') {
            const proveedorDoc = await Proveedor.findById(compra.proveedor).session(session);
            if (!proveedorDoc) {
              await session.abortTransaction();
              session.endSession();
              return res.status(404).json({
                success: false,
                message: 'Proveedor no encontrado'
              });
            }

            const totalConIVA = compra.total || compra.baseTotal;
            const saldoInicial = compra.totalDiscount > 0 ? compra.total : compra.baseTotal;

            await CuentaPorPagar.create([{
              proveedor: compra.proveedor,
              compra: compra._id,
              receiptNumber: compra.invoice,
              hasIVA: totalIVA > 0,
              ivaRate: 0.16,
              subtotal: compra.baseTotal,
              ivaAmount: totalIVA,
              monto: totalConIVA,
              montoBase: compra.baseTotal,
              descuentoDisponible: compra.totalDiscount,
              discountDeadline: compra.discountDeadline,
              saldo: saldoInicial,
              dueDate: compra.dueDate,
              notes: `Cuenta generada por compra ${compra._id}`
            }], { session });

            proveedorDoc.currentDebt += totalConIVA;
            await proveedorDoc.save({ session });
          } else if (type === 'contado' && originalType === 'credito') {
            if (cuentaPorPagar) {
              cuentaPorPagar.status = 'cancelada';
              cuentaPorPagar.saldo = 0;
              await cuentaPorPagar.save({ session });

              const proveedorDoc = await Proveedor.findById(originalProveedor).session(session);
              if (proveedorDoc) {
                proveedorDoc.currentDebt -= compra.monto;
                if (proveedorDoc.currentDebt < 0) proveedorDoc.currentDebt = 0;
                await proveedorDoc.save({ session });
              }
            }
          } else if (type === 'credito' && cuentaPorPagar) {
            const totalConIVA = compra.total || compra.baseTotal;
            const saldoInicial = compra.totalDiscount > 0 ? compra.total : compra.baseTotal;

            cuentaPorPagar.proveedor = compra.proveedor;
            cuentaPorPagar.subtotal = compra.baseTotal;
            cuentaPorPagar.ivaAmount = totalIVA;
            cuentaPorPagar.monto = totalConIVA;
            cuentaPorPagar.montoBase = compra.baseTotal;
            cuentaPorPagar.descuentoDisponible = compra.totalDiscount;
            cuentaPorPagar.discountDeadline = compra.discountDeadline;
            cuentaPorPagar.saldo = saldoInicial;
            cuentaPorPagar.dueDate = compra.dueDate;
            await cuentaPorPagar.save({ session });

            if (proveedor !== undefined || items) {
              const proveedorDoc = await Proveedor.findById(compra.proveedor).session(session);
              if (proveedorDoc) {
                if (proveedor !== undefined) {
                  const oldProveedor = await Proveedor.findById(originalProveedor).session(session);
                  if (oldProveedor) {
                    oldProveedor.currentDebt -= (compra.monto || 0);
                    if (oldProveedor.currentDebt < 0 || isNaN(oldProveedor.currentDebt)) oldProveedor.currentDebt = 0;
                    await oldProveedor.save({ session });
                  }
                  proveedorDoc.currentDebt += (totalConIVA || 0);
                } else {
                  const oldMonto = compra.monto || 0;
                  const newMonto = totalConIVA || 0;
                  proveedorDoc.currentDebt = proveedorDoc.currentDebt - oldMonto + newMonto;
                }
                if (proveedorDoc.currentDebt < 0 || isNaN(proveedorDoc.currentDebt)) proveedorDoc.currentDebt = 0;
                await proveedorDoc.save({ session });
              }
            }
          }

          // Restaurar status original
          compra.status = originalType === 'contado' ? 'pagada' : 'pendiente';
          await compra.save({ session });

          await session.commitTransaction();
          session.endSession();

          await compra.populate('proveedor', 'name contact phone');
          await compra.populate('user', 'name');
          await compra.populate('items.product', 'name sku');

          // Éxito - salir del loop
          return res.json({
            success: true,
            data: compra,
            message: 'Compra actualizada correctamente'
          });
        }

        // Compra con capas FIFO - Validaciones de integridad
        // Verificar número de capas activas coincide con número de items
        const activeLayers = layers.filter(l => l.isActive);
        console.log(`[PUT DEBUG] Validación FIFO: activeLayers.length=${activeLayers.length}, compra.items.length=${compra.items.length}`);
        if (activeLayers.length !== compra.items.length) {
          console.log(`[PUT DEBUG] ERROR: Número de capas activas (${activeLayers.length}) no coincide con items (${compra.items.length})`);
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            success: false,
            message: 'La compra tiene información FIFO incompleta. No se puede modificar de forma segura.'
          });
        }

        // Verificar que cada capa activa corresponde a un item
        for (const layer of activeLayers) {
          const item = compra.items[layer.compraItemIndex];
          if (!item || item.product.toString() !== layer.producto.toString()) {
            console.log(`[PUT DEBUG] ERROR: Capa ${layer._id} no corresponde a item`);
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              success: false,
              message: 'La compra tiene información FIFO inconsistente. No se puede modificar de forma segura.'
            });
          }
        }

        // Verificar que ninguna capa activa ha sido consumida
        for (const layer of activeLayers) {
          if (layer.remainingQuantity < layer.initialQuantity) {
            console.log(`[PUT DEBUG] ERROR: Capa ${layer._id} fue consumida`);
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              success: false,
              message: 'Parte de la mercancía ya fue consumida. La compra no puede modificarse. Se requiere un procedimiento de ajuste.'
            });
          }
        }

        // Verificar que no hay movimientos de salida asociados a capas activas
        for (const layer of activeLayers) {
          const consumptionMovements = await InventoryMovement.find({
            source: 'compra',
            sourceId: compra._id,
            layersConsumed: { $elemMatch: { layerId: layer._id } }
          }).session(session);

          if (consumptionMovements.length > 0) {
            console.log(`[PUT DEBUG] ERROR: Capa ${layer._id} tiene movimientos de consumo`);
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              success: false,
              message: 'Parte de la mercancía ya fue consumida. La compra no puede modificarse. Se requiere un procedimiento de ajuste.'
            });
          }
        }

        // Guardar datos originales
        const originalItems = compra.items;
        const originalType = compra.type;
        const originalProveedor = compra.proveedor;
        const originalVersion = compra.version;
        console.log(`[PUT DEBUG] originalVersion=${originalVersion}, items=${originalItems.length}`);

        const getValue = (...values) => {
          for (const val of values) {
            if (val !== undefined && val !== null) return val;
          }
          return 0;
        };

        // Revertir existencias originales
        for (const originalItem of originalItems) {
          const producto = await Producto.findById(originalItem.product).session(session);
          if (producto) {
            producto.stock -= originalItem.quantity;
            if (producto.stock < 0) producto.stock = 0;
            await producto.save({ session });

            // Crear movimiento de reversión trazable
            const reversalMovement = new InventoryMovement({
              producto: originalItem.product,
              type: 'ajuste_salida',
              quantity: -originalItem.quantity,
              unitCost: originalItem.baseUnitCost,
              totalCost: originalItem.quantity * originalItem.baseUnitCost,
              source: 'modificacion_compra',
              sourceId: compra._id,
              sourceVersion: originalVersion,
              notes: `Reversión de item por modificación de compra ${compra._id} - versión ${originalVersion}`
            });
            await reversalMovement.save({ session });
          }
        }

        // Marcar capas activas originales como inactivas
        for (const layer of activeLayers) {
          layer.isActive = false;
          await layer.save({ session });
        }

        // Actualizar campos de la compra
        if (items) {
          const normalizedItems = items.map(item => ({
            ...item,
            baseUnitCost: getValue(item.baseUnitCost, item.cost, item.unitCost),
            unitCost: getValue(item.unitCost, item.cost, item.baseUnitCost),
            quantity: item.quantity || 1,
            discountPercentage: item.discountPercentage || 0,
            hasTax: item.hasTax !== undefined ? item.hasTax : true,
            taxRate: item.taxRate !== undefined ? item.taxRate : 0.16,
            costIncludesTax: item.costIncludesTax || false
          }));

          compra.items = normalizedItems;
        }

        if (proveedor !== undefined) compra.proveedor = proveedor;
        if (type !== undefined) compra.type = type;
        if (hasIVA !== undefined) compra.hasIVA = hasIVA;
        if (ivaRate !== undefined) compra.ivaRate = ivaRate;
        if (notes !== undefined) compra.notes = notes;
        if (invoice !== undefined) compra.invoice = invoice;
        if (earlyPaymentDiscount !== undefined) compra.earlyPaymentDiscount = earlyPaymentDiscount;
        if (discountDeadline !== undefined) compra.discountDeadline = discountDeadline;
        if (dueDate !== undefined) compra.dueDate = dueDate;
        if (date !== undefined && date !== '') {
          const parsedDate = parseCalendarDate(date);
          if (parsedDate) {
            compra.date = parsedDate;
          }
        }

        // Recalcular totales
        compra.baseTotal = Math.round((compra.items.reduce((sum, item) => {
          const cost = getValue(item.baseUnitCost, item.cost, item.unitCost);
          const qty = item.quantity || 1;
          return sum + (qty * cost);
        }, 0)) * 100) / 100;
        
        compra.totalDiscount = Math.round((compra.items.reduce((sum, item) => {
          const cost = getValue(item.baseUnitCost, item.cost, item.unitCost);
          const qty = item.quantity || 1;
          const discountPct = item.discountPercentage || 0;
          return sum + (qty * cost * (discountPct / 100));
        }, 0)) * 100) / 100;
        
        const totalIVA = Math.round((compra.items.reduce((sum, item) => {
          const cost = getValue(item.baseUnitCost, item.cost, item.unitCost);
          const qty = item.quantity || 1;
          const discountPct = item.discountPercentage || 0;
          const subtotal = (qty * cost) - (qty * cost * (discountPct / 100));
          const itemTax = (item.hasTax !== false) ? (subtotal * (item.taxRate || 0.16)) : 0;
          return sum + itemTax;
        }, 0)) * 100) / 100;
        
        compra.totalIVA = totalIVA;
        compra.total = Math.round((compra.baseTotal - compra.totalDiscount + totalIVA) * 100) / 100;

        // Incrementar versión
        compra.previousVersion = originalVersion;
        compra.version = originalVersion + 1;

        // Guardar clave de idempotencia si se proporcionó
        if (lastModificationIdempotencyKey) {
          compra.lastModificationIdempotencyKey = lastModificationIdempotencyKey;
          compra.modificationIdempotencyKeys.push({
            key: lastModificationIdempotencyKey,
            version: compra.version
          });
        }

        await compra.save({ session });

        // Crear nuevas capas FIFO
        for (let i = 0; i < compra.items.length; i++) {
          const item = compra.items[i];
          const itemIndex = i;

          // Calcular costo FIFO según fórmula aprobada
          const baseSubtotal = item.quantity * item.baseUnitCost;
          const discountAmount = baseSubtotal * (item.discountPercentage / 100);
          const subtotalNeto = baseSubtotal - discountAmount;
          const itemTax = (item.hasTax !== false) ? (subtotalNeto * (item.taxRate || 0.16)) : 0;
          const costoTotalFIFO = subtotalNeto + itemTax;
          const costoUnitarioFIFO = costoTotalFIFO / item.quantity;

          const newLayer = new InventoryLayer({
            producto: item.product,
            purchase: compra._id,
            compraItemIndex: itemIndex,
            compraVersion: compra.version,
            quantity: item.quantity,
            initialQuantity: item.quantity,
            remainingQuantity: item.quantity,
            unitCost: costoUnitarioFIFO,
            totalCost: costoTotalFIFO,
            source: 'compra',
            isActive: true,
            receivedDate: new Date()
          });
          await newLayer.save({ session });

          // Crear movimiento de entrada
          const newMovement = new InventoryMovement({
            producto: item.product,
            type: 'entrada',
            quantity: item.quantity,
            unitCost: costoUnitarioFIFO,
            totalCost: costoTotalFIFO,
            source: 'compra',
            sourceId: compra._id,
            sourceItemIndex: itemIndex,
            sourceVersion: compra.version
          });
          await newMovement.save({ session });
        }

        // Actualizar stock de nuevos items
        for (const item of compra.items) {
          const producto = await Producto.findById(item.product).session(session);
          if (producto) {
            producto.stock += item.quantity;
            await producto.save({ session });
          }
        }

        // Manejo de CuentaPorPagar (misma lógica que anterior)
        if (type === 'credito' && originalType === 'contado') {
          const proveedorDoc = await Proveedor.findById(compra.proveedor).session(session);
          if (!proveedorDoc) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({
              success: false,
              message: 'Proveedor no encontrado'
            });
          }

          const totalConIVA = compra.total || compra.baseTotal;
          const saldoInicial = compra.totalDiscount > 0 ? compra.total : compra.baseTotal;

          await CuentaPorPagar.create([{
            proveedor: compra.proveedor,
            compra: compra._id,
            receiptNumber: compra.invoice,
            hasIVA: totalIVA > 0,
            ivaRate: 0.16,
            subtotal: compra.baseTotal,
            ivaAmount: totalIVA,
            monto: totalConIVA,
            montoBase: compra.baseTotal,
            descuentoDisponible: compra.totalDiscount,
            discountDeadline: compra.discountDeadline,
            saldo: saldoInicial,
            dueDate: compra.dueDate,
            notes: `Cuenta generada por compra ${compra._id}`
          }], { session });

          proveedorDoc.currentDebt += totalConIVA;
          await proveedorDoc.save({ session });
        } else if (type === 'contado' && originalType === 'credito') {
          if (cuentaPorPagar) {
            cuentaPorPagar.status = 'cancelada';
            cuentaPorPagar.saldo = 0;
            await cuentaPorPagar.save({ session });

            const proveedorDoc = await Proveedor.findById(originalProveedor).session(session);
            if (proveedorDoc) {
              proveedorDoc.currentDebt -= compra.monto;
              if (proveedorDoc.currentDebt < 0) proveedorDoc.currentDebt = 0;
              await proveedorDoc.save({ session });
            }
          }
        } else if (type === 'credito' && cuentaPorPagar) {
          const totalConIVA = compra.total || compra.baseTotal;
          const saldoInicial = compra.totalDiscount > 0 ? compra.total : compra.baseTotal;

          cuentaPorPagar.proveedor = compra.proveedor;
          cuentaPorPagar.subtotal = compra.baseTotal;
          cuentaPorPagar.ivaAmount = totalIVA;
          cuentaPorPagar.monto = totalConIVA;
          cuentaPorPagar.montoBase = compra.baseTotal;
          cuentaPorPagar.descuentoDisponible = compra.totalDiscount;
          cuentaPorPagar.discountDeadline = compra.discountDeadline;
          cuentaPorPagar.saldo = saldoInicial;
          cuentaPorPagar.dueDate = compra.dueDate;
          await cuentaPorPagar.save({ session });

          if (proveedor !== undefined || items) {
            const proveedorDoc = await Proveedor.findById(compra.proveedor).session(session);
            if (proveedorDoc) {
              if (proveedor !== undefined) {
                const oldProveedor = await Proveedor.findById(originalProveedor).session(session);
                if (oldProveedor) {
                  oldProveedor.currentDebt -= (compra.monto || 0);
                  if (oldProveedor.currentDebt < 0 || isNaN(oldProveedor.currentDebt)) oldProveedor.currentDebt = 0;
                  await oldProveedor.save({ session });
                }
                proveedorDoc.currentDebt += (totalConIVA || 0);
              } else {
                const oldMonto = compra.monto || 0;
                const newMonto = totalConIVA || 0;
                proveedorDoc.currentDebt = proveedorDoc.currentDebt - oldMonto + newMonto;
              }
              if (proveedorDoc.currentDebt < 0 || isNaN(proveedorDoc.currentDebt)) proveedorDoc.currentDebt = 0;
              await proveedorDoc.save({ session });
            }
          }
        }

        // Restaurar status original
        compra.status = originalType === 'contado' ? 'pagada' : 'pendiente';
        await compra.save({ session });

        await session.commitTransaction();
        session.endSession();

        await compra.populate('proveedor', 'name contact phone');
        await compra.populate('user', 'name');
        await compra.populate('items.product', 'name sku');

        // Éxito - salir del loop
        return res.json({
          success: true,
          data: compra,
          message: 'Compra actualizada correctamente'
        });

      } catch (error) {
        console.error(`Error al actualizar compra (intento ${attempt + 1}/${maxRetries}):`, error);
        
        await session.abortTransaction();
        session.endSession();

        // Reintentar si es error transitorio
        if (isTransientTransactionError(error) && attempt < maxRetries - 1) {
          lastError = error;
          console.log(`Reintentando después de error transitorio (${attempt + 1}/${maxRetries})`);
          await sleep(retryDelay * (attempt + 1));
          continue;
        }

        // Si no es transitorio o se agotaron reintentos, retornar error
        if (error.name === 'ValidationError') {
          const messages = Object.values(error.errors).map(val => val.message);
          return res.status(400).json({
            success: false,
            message: messages.join(', ')
          });
        }
        
        if (error.message === 'Perdida de lock - otra solicitud modificó la compra' || 
            error.message === 'Perdida de lock antes de escritura') {
          return res.status(409).json({
            success: false,
            message: 'La compra está siendo modificada por otro proceso'
          });
        }
        
        return res.status(500).json({
          success: false,
          message: 'Error al actualizar compra'
        });
      }
    }

    // Si se agotaron reintentos para error transitorio
    if (lastError) {
      console.error('Se agotaron reintentos para error transitorio:', lastError);
      return res.status(500).json({
        success: false,
        message: 'Error al actualizar compra después de múltiples reintentos'
      });
    }

  } catch (error) {
    console.error('Error general en PUT:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al actualizar compra'
    });
  } finally {
    // Siempre liberar lock y detener heartbeat
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (lockAcquired) {
      await releaseLock(req.params.id, lockToken);
    }
  }
});

// @route   DELETE /api/compras/:id
// @desc    Cancelar compra y devolver stock (protegido con FIFO)
router.delete('/:id', authenticateToken, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const compra = await Compra.findById(req.params.id).session(session);
    
    if (!compra) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: 'Compra no encontrada'
      });
    }

    if (compra.status === 'cancelada') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'La compra ya está cancelada'
      });
    }

    // Verificar si hay capas FIFO asociadas a esta compra
    const layers = await InventoryLayer.find({ purchase: compra._id }).session(session);

    if (layers.length === 0) {
      // Compra sin capas FIFO (compra anterior a FIFO), permitir cancelación con lógica original
      for (const item of compra.items) {
        const producto = await Producto.findById(item.product).session(session);
        if (producto) {
          producto.stock -= item.quantity;
          if (producto.stock < 0) producto.stock = 0;
          await producto.save({ session });
        }
      }

      // Si es a crédito, actualizar cuenta por pagar y deuda del proveedor
      if (compra.type === 'credito') {
        const cuentaPorPagar = await CuentaPorPagar.findOne({ compra: compra._id }).session(session);
        if (cuentaPorPagar) {
          // Verificar si la cuenta por pagar tiene pagos
          if (cuentaPorPagar.payments && cuentaPorPagar.payments.length > 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              success: false,
              message: 'Esta compra tiene pagos registrados y no puede cancelarse'
            });
          }
          cuentaPorPagar.status = 'cancelada';
          await cuentaPorPagar.save({ session });

          const proveedor = await Proveedor.findById(compra.proveedor).session(session);
          if (proveedor) {
            proveedor.currentDebt -= compra.total;
            if (proveedor.currentDebt < 0) proveedor.currentDebt = 0;
            await proveedor.save({ session });
          }
        }
      }

      compra.status = 'cancelada';
      await compra.save({ session });

      await session.commitTransaction();
      session.endSession();

      return res.json({
        success: true,
        message: 'Compra cancelada y stock devuelto'
      });
    }

    // Compra con capas FIFO - verificar consumo
    for (const layer of layers) {
      // Verificar si la capa ha sido consumida
      if (layer.remainingQuantity < layer.initialQuantity) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: 'Parte de la mercancía ya fue consumida. La compra no puede cancelarse. Se requiere un procedimiento de ajuste.'
        });
      }

      // Verificar si hay movimientos de salida asociados a esta capa
      const consumptionMovements = await InventoryMovement.find({
        source: 'compra',
        sourceId: compra._id,
        layersConsumed: { $elemMatch: { layerId: layer._id } }
      }).session(session);

      if (consumptionMovements.length > 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: 'Parte de la mercancía ya fue consumida. La compra no puede cancelarse. Se requiere un procedimiento de ajuste.'
        });
      }
    }

    // Verificar cuenta por pagar si es a crédito
    if (compra.type === 'credito') {
      const cuentaPorPagar = await CuentaPorPagar.findOne({ compra: compra._id }).session(session);
      if (cuentaPorPagar) {
        // Verificar si la cuenta por pagar tiene pagos
        if (cuentaPorPagar.payments && cuentaPorPagar.payments.length > 0) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            success: false,
            message: 'Esta compra tiene pagos registrados y no puede cancelarse'
          });
        }
        cuentaPorPagar.status = 'cancelada';
        await cuentaPorPagar.save({ session });

        const proveedor = await Proveedor.findById(compra.proveedor).session(session);
        if (proveedor) {
          proveedor.currentDebt -= compra.total;
          if (proveedor.currentDebt < 0) proveedor.currentDebt = 0;
          await proveedor.save({ session });
        }
      }
    }

    // Devolver stock al inventario
    for (const item of compra.items) {
      const producto = await Producto.findById(item.product).session(session);
      if (producto) {
        producto.stock -= item.quantity;
        if (producto.stock < 0) producto.stock = 0;
        await producto.save({ session });
      }
    }

    // Registrar movimientos de reversión trazables
    for (const layer of layers) {
      const reversalMovement = new InventoryMovement({
        producto: layer.producto,
        type: 'ajuste_salida',
        quantity: -layer.initialQuantity,
        unitCost: layer.unitCost,
        totalCost: layer.totalCost,
        source: 'cancelacion_compra',
        sourceId: compra._id,
        notes: `Reversión de compra ${compra._id} - Capa ${layer._id}`
      });
      await reversalMovement.save({ session });
    }

    // Marcar capas como inactivas (canceladas)
    for (const layer of layers) {
      layer.isActive = false;
      await layer.save({ session });
    }

    // Actualizar status de compra
    compra.status = 'cancelada';
    await compra.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json({
      success: true,
      message: 'Compra cancelada, stock devuelto y capas FIFO marcadas como inactivas'
    });
  } catch (error) {
    console.error('Error al cancelar compra:', error);
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({
      success: false,
      message: 'Error al cancelar compra',
      error: error.message
    });
  }
});

module.exports = router;

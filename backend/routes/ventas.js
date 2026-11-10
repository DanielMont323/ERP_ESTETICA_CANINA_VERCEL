const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Venta = require('../models/Venta');
const Producto = require('../models/Producto');
const Servicio = require('../models/Servicio');
const Cliente = require('../models/Cliente');
const Mascota = require('../models/Mascota');
const CarnetVacunacion = require('../models/CarnetVacunacion');
const Recordatorio = require('../models/Recordatorio');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { getCurrentDateGMT7, parseCalendarDate } = require('../helpers/timezone');
const { consumirFIFOEnVenta } = require('../helpers/consumoFifo');
const { revertirFIFOEnVenta } = require('../helpers/revertirFifoVenta');
const { validarSincronizacionStockCapas } = require('../helpers/validarSincronizacionStockCapas');
const { revertirHistorialMedicoYCarnet } = require('../helpers/revertirHistorialMedicoYCarnet');
const { actualizarHistorialMedicoYCarnet } = require('../helpers/actualizarHistorialMedicoYCarnet');
const router = express.Router();

// @route   GET /api/ventas
// @desc    Obtener todas las ventas
router.get('/', async (req, res) => {
  try {
    const { date, startDate, endDate, customer, status, userId, page = 1, limit = 50 } = req.query;
    let query = {};

    // Filtro por fecha única (compatibilidad con existente)
    if (date && !startDate && !endDate) {
      const filterDate = parseCalendarDate(date);
      if (filterDate) {
        const startOfDay = new Date(filterDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(filterDate);
        endOfDay.setHours(23, 59, 59, 999);
        query.date = { $gte: startOfDay, $lte: endOfDay };
      }
    }
    
    // Filtro por rango de fechas
    if (startDate && endDate) {
      const start = parseCalendarDate(startDate);
      const end = parseCalendarDate(endDate);
      
      if (start && end) {
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        
        // Validar que startDate <= endDate
        if (start > end) {
          return res.status(400).json({
            success: false,
            message: 'La fecha inicial debe ser menor o igual a la fecha final'
          });
        }
        
        query.date = { $gte: start, $lte: end };
      }
    } else if (startDate && !endDate) {
      // Solo startDate
      const start = parseCalendarDate(startDate);
      if (start) {
        start.setHours(0, 0, 0, 0);
        query.date = { $gte: start };
      }
    } else if (!startDate && endDate) {
      // Solo endDate
      const end = parseCalendarDate(endDate);
      if (end) {
        end.setHours(23, 59, 59, 999);
        query.date = { $lte: end };
      }
    }

    if (customer) query.customer = customer;
    if (status) query.status = status;
    if (userId) query.user = userId;

    const ventas = await Venta.find(query)
      .populate('customer', 'name phone')
      .populate('user', 'name')
      .sort({ date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Populate items y manejar productos/servicios eliminados
    const allProductIds = new Set();
    const allServiceIds = new Set();
    
    ventas.forEach(venta => {
      venta.items.forEach(item => {
        if (item.type === 'producto') {
          allProductIds.add(item.item);
        } else if (item.type === 'servicio') {
          allServiceIds.add(item.item);
        }
      });
    });

    const productos = await Producto.find({ _id: { $in: Array.from(allProductIds) } }).select('name price');
    const servicios = await Servicio.find({ _id: { $in: Array.from(allServiceIds) } }).select('name price');
    
    const productoMap = new Map(productos.map(p => [p._id.toString(), p]));
    const servicioMap = new Map(servicios.map(s => [s._id.toString(), s]));

    ventas.forEach(venta => {
      venta.items.forEach(item => {
        if (item.type === 'producto') {
          item.item = productoMap.get(item.item.toString()) || { name: 'Producto no disponible', price: 0 };
        } else if (item.type === 'servicio') {
          item.item = servicioMap.get(item.item.toString()) || { name: 'Servicio no disponible', price: 0 };
        }
      });
    });

    const total = await Venta.countDocuments(query);

    res.json({
      success: true,
      data: ventas,
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
      message: 'Error al obtener ventas'
    });
  }
});

// @route   GET /api/ventas/by-mascota/:mascotaId
// @desc    Obtener ventas por mascota
router.get('/by-mascota/:mascotaId', authenticateToken, async (req, res) => {
  try {
    const { mascotaId } = req.params;

    const ventas = await Venta.find({ mascota: mascotaId })
      .populate('customer', 'name phone')
      .populate('mascota', 'name type breed')
      .populate('user', 'name')
      .sort({ date: -1 });

    // Populate items manualmente según el tipo
    for (const venta of ventas) {
      for (const item of venta.items) {
        if (item.type === 'producto') {
          const producto = await Producto.findById(item.item).select('name price');
          item.item = producto || { name: 'Producto no disponible', price: 0 };
        } else if (item.type === 'servicio') {
          const servicio = await Servicio.findById(item.item).select('name price');
          item.item = servicio || { name: 'Servicio no disponible', price: 0 };
        }
      }
    }

    res.json({
      success: true,
      data: ventas
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener ventas de la mascota'
    });
  }
});

// @route   GET /api/ventas/:id
// @desc    Obtener venta por ID
router.get('/:id', async (req, res) => {
  try {
    const venta = await Venta.findById(req.params.id)
      .populate('customer', 'name phone email')
      .populate('mascota', 'name')
      .populate('user', 'name')
      .populate('items.item')
      .populate('items.mascota', 'name');
    
    if (!venta) {
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }
    
    res.json({
      success: true,
      data: venta
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener venta'
    });
  }
});

// @route   POST /api/ventas
// @desc    Crear nueva venta
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { items, paymentMethod, payments, customer, mascota, notes, amountReceived, saleChannel, commission, subtotal, total, netIncome, date, manualFinancials, employeeDiscountApplied, employeeDiscountPercentage } = req.body;

    console.log('DEBUG req.body.employeeDiscountApplied:', employeeDiscountApplied);
    console.log('DEBUG req.body.employeeDiscountPercentage:', employeeDiscountPercentage);
    console.log('DEBUG typeof employeeDiscountApplied:', typeof employeeDiscountApplied);

    // Usar req.user._id para el usuario autenticado (ignorar user del body por seguridad)
    const user = req.user._id;

    // Validar rol ADMIN para edición financiera manual en Mercado Libre
    if (saleChannel === 'mercado_libre' && (subtotal !== undefined || total !== undefined || netIncome !== undefined)) {
      if (req.user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Solo los administradores pueden modificar valores financieros en ventas de Mercado Libre'
        });
      }
    }

    // Validar que si es Mercado Libre con ajuste financiero manual, se proporcionen total y netIncome válidos
    if (saleChannel === 'mercado_libre' && manualFinancials === true) {
      const isTotalValid = total !== undefined && total !== null && !isNaN(total) && typeof total === 'number' && isFinite(total);
      const isNetIncomeValid = netIncome !== undefined && netIncome !== null && !isNaN(netIncome) && typeof netIncome === 'number' && isFinite(netIncome);
      
      if (!isTotalValid || !isNetIncomeValid) {
        return res.status(400).json({
          success: false,
          message: 'Para una venta de Mercado Libre con ajuste financiero manual se requieren total y utilidad neta válidos'
        });
      }
    }

    // 1. Validar que haya items
    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'La venta debe tener al menos un item'
      });
    }

    // 1.5. Validar pagos
    let effectivePayments = [];
    let effectivePaymentMethod = paymentMethod;
    
    if (payments && payments.length > 0) {
      // Usar payments[] proporcionado
      effectivePayments = payments;
      
      // Validar que cada pago tenga method y amount
      for (const payment of payments) {
        if (!payment.method || !['efectivo', 'tarjeta', 'transferencia'].includes(payment.method)) {
          return res.status(400).json({
            success: false,
            message: 'Método de pago inválido. Debe ser: efectivo, tarjeta o transferencia'
          });
        }
        if (payment.amount === undefined || payment.amount < 0) {
          return res.status(400).json({
            success: false,
            message: 'El monto de pago debe ser un número positivo'
          });
        }
      }
      
      // Calcular total de pagos
      const totalPayments = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
      
      // Validar que la suma de pagos coincida con el total (se validará después de calcular el total)
      // Por ahora guardamos para validar después
      req.totalPayments = totalPayments;
      
      // Determinar paymentMethod principal para compatibilidad (primer pago o mayor monto)
      if (payments.length === 1) {
        effectivePaymentMethod = payments[0].method;
      } else {
        // Usar el método con mayor monto
        const maxPayment = payments.reduce((max, p) => (p.amount > max.amount ? p : max), payments[0]);
        effectivePaymentMethod = maxPayment.method;
      }
    } else {
      // Compatibilidad con ventas antiguas: usar paymentMethod
      if (!paymentMethod || !['efectivo', 'tarjeta', 'transferencia'].includes(paymentMethod)) {
        return res.status(400).json({
          success: false,
          message: 'Método de pago inválido. Debe ser: efectivo, tarjeta o transferencia'
        });
      }
    }

    // 1.6. Validar descuento de empleado excluye descuentos individuales
    if (employeeDiscountApplied === true) {
      // Verificar que ningún item tenga descuento individual
      const hasIndividualDiscounts = items.some(item => 
        item.discountType && item.discountType !== 'ninguno' && item.discountAmount > 0
      );
      
      if (hasIndividualDiscounts) {
        return res.status(400).json({
          success: false,
          message: 'El descuento de empleado no puede combinarse con descuentos individuales por producto o servicio'
        });
      }
      
      // Validar que el porcentaje sea 20%
      if (employeeDiscountPercentage !== undefined && employeeDiscountPercentage !== 20) {
        return res.status(400).json({
          success: false,
          message: 'El porcentaje de descuento de empleado debe ser 20%'
        });
      }
    }

    // 1.5. Detectar si hay vacunas o desparasitantes en la venta y validar mascotas por item
    let hasVaccines = false;
    let hasDewormers = false;
    const vaccineProducts = [];
    const dewormerProducts = [];
    
    // Función para verificar si un string es un ObjectId válido de MongoDB (24 caracteres hex)
    const isObjectId = (str) => {
      return typeof str === 'string' && /^[0-9a-fA-F]{24}$/.test(str);
    };
    
    // Función para obtener el nombre de la categoría
    const getCategoryName = async (category) => {
      if (!category) return '';
      
      if (category && typeof category === 'object') {
        // Si es ObjectId, buscar la categoría por nombre
        const CategoriaProducto = require('../models/CategoriaProducto');
        const categoriaDoc = await CategoriaProducto.findById(category);
        return categoriaDoc ? categoriaDoc.name : '';
      } else if (category && isObjectId(category)) {
        // Si es String pero parece un ObjectId, buscar en CategoriaProducto
        const CategoriaProducto = require('../models/CategoriaProducto');
        const categoriaDoc = await CategoriaProducto.findById(category);
        return categoriaDoc ? categoriaDoc.name : '';
      } else if (category && typeof category === 'string') {
        // Si es String normal, usar directamente
        return category;
      }
      return '';
    };
    
    // Función para verificar si una categoría es vacuna o desparasitante
    const isVaccineOrDewormer = (categoryName) => {
      const categoryLower = categoryName.toString().toLowerCase();
      return categoryLower === 'vacunas' || categoryLower === 'vacuna' ||
             categoryLower === 'desparasitantes' || categoryLower === 'desparasitante' ||
             categoryLower.includes('desparasitante');
    };
    
    // Función para calcular próxima dosis a partir de días
    const calculateNextDoseDate = (dias, fechaBase = null) => {
      if (!dias || dias <= 0) return null;
      const baseDate = fechaBase || getCurrentDateGMT7();
      const nextDate = new Date(baseDate);
      nextDate.setDate(nextDate.getDate() + parseInt(dias));
      return nextDate;
    };
    
    for (const item of items) {
      if (item.type === 'producto') {
        const producto = await Producto.findById(item.item);
        if (producto) {
          const categoryName = await getCategoryName(producto.category);
          const isVaccineDewormer = isVaccineOrDewormer(categoryName);
          
          if (isVaccineDewormer) {
            // Calcular nextDoseDate a partir de diasProximaDosis si se proporciona
            let calculatedNextDoseDate = item.nextDoseDate;
            if (item.diasProximaDosis && !item.nextDoseDate) {
              calculatedNextDoseDate = calculateNextDoseDate(item.diasProximaDosis);
            }
            
            // Validar aplicaciones array para múltiples mascotas
            if (item.aplicaciones && item.aplicaciones.length > 0) {
              // Validar que cada aplicación tenga mascota
              for (const aplicacion of item.aplicaciones) {
                if (!aplicacion.mascota) {
                  return res.status(400).json({
                    success: false,
                    message: `El producto "${producto.name}" es una vacuna/desparasitante y cada aplicación debe tener una mascota asociada`
                  });
                }
                
                // Validar que la mascota pertenezca al cliente
                if (!customer) {
                  return res.status(400).json({
                    success: false,
                    message: 'Para vender vacunas o desparasitantes debe seleccionar un cliente'
                  });
                }
                
                const mascotaDoc = await Mascota.findById(aplicacion.mascota);
                if (!mascotaDoc) {
                  return res.status(404).json({
                    success: false,
                    message: 'Mascota no encontrada'
                  });
                }
                
                if (!mascotaDoc.owner || mascotaDoc.owner.toString() !== customer) {
                  return res.status(403).json({
                    success: false,
                    message: `La mascota "${mascotaDoc.name}" no pertenece al cliente seleccionado`
                  });
                }
                
                // Calcular próxima dosis para cada aplicación si no está definida
                if (!aplicacion.proximaDosis && item.diasProximaDosis) {
                  aplicacion.proximaDosis = calculateNextDoseDate(item.diasProximaDosis, aplicacion.fechaAplicacion);
                }
              }
              
              const categoryLower = categoryName.toString().toLowerCase();
              if (categoryLower === 'vacunas' || categoryLower === 'vacuna') {
                hasVaccines = true;
                vaccineProducts.push({ 
                  producto, 
                  quantity: item.quantity, 
                  nextDoseDate: calculatedNextDoseDate, 
                  aplicaciones: item.aplicaciones 
                });
              } else {
                hasDewormers = true;
                dewormerProducts.push({ 
                  producto, 
                  quantity: item.quantity, 
                  nextDoseDate: calculatedNextDoseDate, 
                  aplicaciones: item.aplicaciones 
                });
              }
            } else {
              // Compatibilidad con código existente: usar mascota a nivel de item
              if (!item.mascota) {
                return res.status(400).json({
                  success: false,
                  message: `El producto "${producto.name}" es una vacuna/desparasitante y debe tener una mascota asociada`
                });
              }
              
              // Validar que la mascota pertenezca al cliente
              if (!customer) {
                return res.status(400).json({
                  success: false,
                  message: 'Para vender vacunas o desparasitantes debe seleccionar un cliente'
                });
              }
              
              const mascotaDoc = await Mascota.findById(item.mascota);
              if (!mascotaDoc) {
                return res.status(404).json({
                  success: false,
                  message: 'Mascota no encontrada'
                });
              }
              
              if (!mascotaDoc.owner || mascotaDoc.owner.toString() !== customer) {
                return res.status(403).json({
                  success: false,
                  message: `La mascota "${mascotaDoc.name}" no pertenece al cliente seleccionado`
                });
              }
              
              const categoryLower = categoryName.toString().toLowerCase();
              if (categoryLower === 'vacunas' || categoryLower === 'vacuna') {
                hasVaccines = true;
                vaccineProducts.push({ producto, quantity: item.quantity, nextDoseDate: calculatedNextDoseDate, mascota: item.mascota });
              } else {
                hasDewormers = true;
                dewormerProducts.push({ producto, quantity: item.quantity, nextDoseDate: calculatedNextDoseDate, mascota: item.mascota });
              }
            }
          }
        }
      }
    }

    // 1.7. Validar que los servicios tengan mascota asociada
    for (const item of items) {
      if (item.type === 'servicio') {
        if (!item.mascota) {
          const servicio = await Servicio.findById(item.item);
          return res.status(400).json({
            success: false,
            message: `El servicio "${servicio ? servicio.name : 'desconocido'}" debe tener una mascota asociada`
          });
        }

        // Validar que la mascota pertenezca al cliente
        if (!customer) {
          return res.status(400).json({
            success: false,
            message: 'Para vender servicios debe seleccionar un cliente'
          });
        }

        const mascotaDoc = await Mascota.findById(item.mascota);
        if (!mascotaDoc) {
          return res.status(404).json({
            success: false,
            message: 'Mascota no encontrada'
          });
        }

        if (!mascotaDoc.owner || mascotaDoc.owner.toString() !== customer) {
          return res.status(403).json({
            success: false,
            message: `La mascota "${mascotaDoc.name}" no pertenece al cliente seleccionado`
          });
        }
      }
    }

    // Mantener compatibilidad con ventas antiguas que usan mascota a nivel de venta
    if (mascota && !customer) {
      return res.status(400).json({
        success: false,
        message: 'Si se selecciona una mascota, debe seleccionar un cliente'
      });
    }

    if (mascota && customer) {
      const mascotaDoc = await Mascota.findById(mascota);
      if (mascotaDoc && (!mascotaDoc.owner || mascotaDoc.owner.toString() !== customer)) {
        return res.status(403).json({
          success: false,
          message: 'La mascota no pertenece al cliente seleccionado'
        });
      }
    }

    // 3. Validar monto recibido para efectivo
    if (effectivePaymentMethod === 'efectivo' && !payments) {
      // Compatibilidad con ventas antiguas
      if (!amountReceived || amountReceived < 0) {
        return res.status(400).json({
          success: false,
          message: 'El monto recibido es requerido para pagos en efectivo'
        });
      }
    }

    // 4. Iniciar transacción MongoDB para atomicidad de inventario
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 5. Crear venta (dentro de la transacción)
      const venta = await Venta.create([{
        items,
        paymentMethod: effectivePaymentMethod,
        ...(effectivePayments.length > 0 && { payments: effectivePayments }),
        saleChannel,
        customer,
        mascota,
        user,
        notes,
        commission,
        status: 'completada',
        ...(date && { date: new Date(date) }),
        ...(employeeDiscountApplied !== undefined && { employeeDiscountApplied }),
        ...(employeeDiscountPercentage !== undefined && { employeeDiscountPercentage }),
        ...(saleChannel === 'mercado_libre' && manualFinancials !== undefined && { manualFinancials }),
        ...(saleChannel === 'mercado_libre' && subtotal !== undefined && { subtotal }),
        ...(saleChannel === 'mercado_libre' && total !== undefined && { total }),
        ...(saleChannel === 'mercado_libre' && netIncome !== undefined && { netIncome })
      }], { session });
      const ventaDoc = venta[0];

      // 5.5. Validar que los pagos coincidan con el total (si se usó payments[])
      if (effectivePayments.length > 0) {
        const totalPayments = effectivePayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        const tolerance = 0.01;

        const hasCashPayment = effectivePayments.some(p => p.method === 'efectivo');

        if (hasCashPayment) {
          if (totalPayments < ventaDoc.total - tolerance) {
            const missing = ventaDoc.total - totalPayments;
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              success: false,
              message: `Faltan $${missing.toFixed(2)} para completar el pago`
            });
          }
        } else {
          if (Math.abs(totalPayments - ventaDoc.total) > tolerance) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              success: false,
              message: `La suma de pagos ($${totalPayments.toFixed(2)}) no coincide con el total de la venta ($${ventaDoc.total.toFixed(2)})`
            });
          }
        }

        const cashPayments = effectivePayments.filter(p => p.method === 'efectivo');
        if (cashPayments.length > 0) {
          const totalCash = cashPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
          const nonCashTotal = effectivePayments.filter(p => p.method !== 'efectivo').reduce((sum, p) => sum + (p.amount || 0), 0);

          const cashRequired = ventaDoc.total - nonCashTotal;
          const calculatedChange = Math.round((totalCash - cashRequired) * 100) / 100;

          if (calculatedChange >= 0) {
            ventaDoc.amountReceived = totalCash;
            ventaDoc.change = calculatedChange;
            await ventaDoc.save({ session });
          }
        }
      }

      // 6. Calcular y validar cambio para efectivo (compatibilidad con ventas antiguas)
      if (!payments && effectivePaymentMethod === 'efectivo' && amountReceived) {
        const calculatedChange = Math.round((amountReceived - ventaDoc.total) * 100) / 100;

        if (calculatedChange < 0) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            success: false,
            message: `El monto recibido es insuficiente. Faltan $${Math.abs(calculatedChange).toFixed(2)}`
          });
        }

        ventaDoc.amountReceived = amountReceived;
        ventaDoc.change = calculatedChange;
        await ventaDoc.save({ session });
      }

      // 7. Consumir capas FIFO usando función auxiliar
      await consumirFIFOEnVenta(items, ventaDoc._id, ventaDoc.date, req.user._id, session);

      // 8. Registrar servicios en el historial médico de las mascotas (dentro de la transacción)
      for (const item of items) {
        if (item.type === 'servicio' && item.mascota) {
          const servicio = await Servicio.findById(item.item);
          if (servicio) {
            const mascotaDoc = await Mascota.findById(item.mascota);
            if (mascotaDoc) {
              await Mascota.findByIdAndUpdate(
                item.mascota,
                {
                  $push: {
                    medicalHistory: {
                      date: ventaDoc.date,
                      description: `Servicio: ${servicio.name} (Venta #${ventaDoc._id})`,
                      veterinarian: req.user.name || 'Sistema',
                      cost: item.subtotalAfterDiscount || (item.quantity * item.unitPrice)
                    }
                  }
                },
                { session }
              );
            }
          }
        }
      }

      // 9. Registrar vacunas y desparasitantes en el carnet si aplica (dentro de la transacción)
      if (hasVaccines || hasDewormers) {
        try {
          for (const { producto, quantity, nextDoseDate, aplicaciones, mascota } of vaccineProducts) {
            const clienteDoc = await Cliente.findById(customer);

            if (aplicaciones && aplicaciones.length > 0) {
              for (const aplicacion of aplicaciones) {
                const mascotaDoc = await Mascota.findById(aplicacion.mascota);
                let carnet = await CarnetVacunacion.findOne({ mascota: aplicacion.mascota }).session(session);

                if (!carnet) {
                  carnet = new CarnetVacunacion({
                    mascota: aplicacion.mascota,
                    nombreMascota: mascotaDoc.name,
                    especie: mascotaDoc.type,
                    raza: mascotaDoc.breed,
                    propietario: customer,
                    nombrePropietario: clienteDoc.name,
                    vacunas: []
                  });
                }

                const vacunaEntry = {
                  vacuna: producto._id,
                  nombre: producto.name,
                  tipo: 'vacuna',
                  fecha: aplicacion.fechaAplicacion || getCurrentDateGMT7(),
                  proximaDosis: aplicacion.proximaDosis || nextDoseDate || null,
                  diasProximaDosis: aplicacion.diasProximaDosis || null,
                  venta: ventaDoc._id
                };
                carnet.vacunas.push(vacunaEntry);
                await carnet.save({ session });
              }
            } else {
              const mascotaDoc = await Mascota.findById(mascota);
              let carnet = await CarnetVacunacion.findOne({ mascota }).session(session);

              if (!carnet) {
                carnet = new CarnetVacunacion({
                  mascota,
                  nombreMascota: mascotaDoc.name,
                  especie: mascotaDoc.type,
                  raza: mascotaDoc.breed,
                  propietario: customer,
                  nombrePropietario: clienteDoc.name,
                  vacunas: []
                });
              }

              for (let i = 0; i < quantity; i++) {
                const vacunaEntry = {
                  vacuna: producto._id,
                  nombre: producto.name,
                  tipo: 'vacuna',
                  fecha: getCurrentDateGMT7(),
                  proximaDosis: nextDoseDate || null,
                  venta: ventaDoc._id
                };
                carnet.vacunas.push(vacunaEntry);
              }

              await carnet.save({ session });
            }
          }

          for (const { producto, quantity, nextDoseDate, aplicaciones, mascota } of dewormerProducts) {
            const clienteDoc = await Cliente.findById(customer);

            if (aplicaciones && aplicaciones.length > 0) {
              for (const aplicacion of aplicaciones) {
                const mascotaDoc = await Mascota.findById(aplicacion.mascota);
                let carnet = await CarnetVacunacion.findOne({ mascota: aplicacion.mascota }).session(session);

                if (!carnet) {
                  carnet = new CarnetVacunacion({
                    mascota: aplicacion.mascota,
                    nombreMascota: mascotaDoc.name,
                    especie: mascotaDoc.type,
                    raza: mascotaDoc.breed,
                    propietario: customer,
                    nombrePropietario: clienteDoc.name,
                    vacunas: []
                  });
                }

                const desparasitanteEntry = {
                  vacuna: producto._id,
                  nombre: producto.name,
                  tipo: 'desparasitante',
                  fecha: aplicacion.fechaAplicacion || getCurrentDateGMT7(),
                  proximaDosis: aplicacion.proximaDosis || nextDoseDate || null,
                  diasProximaDosis: aplicacion.diasProximaDosis || null,
                  venta: ventaDoc._id
                };
                carnet.vacunas.push(desparasitanteEntry);
                await carnet.save({ session });
              }
            } else {
              const mascotaDoc = await Mascota.findById(mascota);
              let carnet = await CarnetVacunacion.findOne({ mascota }).session(session);

              if (!carnet) {
                carnet = new CarnetVacunacion({
                  mascota,
                  nombreMascota: mascotaDoc.name,
                  especie: mascotaDoc.type,
                  raza: mascotaDoc.breed,
                  propietario: customer,
                  nombrePropietario: clienteDoc.name,
                  vacunas: []
                });
              }

              for (let i = 0; i < quantity; i++) {
                const desparasitanteEntry = {
                  vacuna: producto._id,
                  nombre: producto.name,
                  tipo: 'desparasitante',
                  fecha: getCurrentDateGMT7(),
                  proximaDosis: nextDoseDate || null,
                  venta: ventaDoc._id
                };
                carnet.vacunas.push(desparasitanteEntry);
              }

              await carnet.save({ session });
            }
          }
        } catch (error) {
          await session.abortTransaction();
          session.endSession();
          console.error('Error al registrar vacunas/desparasitantes en carnet:', error);
          return res.status(500).json({
            success: false,
            message: 'Error al registrar vacunas/desparasitantes en carnet'
          });
        }
      }

      // 10. Registrar servicios asociados a mascotas en medicalHistory (dentro de la transacción)
      for (const item of items) {
        if (item.type === 'servicio' && item.mascota) {
          try {
            const servicio = await Servicio.findById(item.item);
            if (servicio) {
              const mascota = await Mascota.findById(item.mascota);
              if (mascota) {
                mascota.medicalHistory.push({
                  description: `Servicio: ${servicio.name}`,
                  cost: item.subtotal || (item.quantity * item.unitPrice),
                  date: getCurrentDateGMT7(),
                  veterinarian: user ? await (await require('../models/Usuario').findById(user)).name : 'Sistema'
                });
                await mascota.save({ session });
              }
            }
          } catch (error) {
            await session.abortTransaction();
            session.endSession();
            console.error('Error al registrar servicio en historial médico:', error);
            return res.status(500).json({
              success: false,
              message: 'Error al registrar servicio en historial médico'
            });
          }
        }
      }

      // 11. Commit de la transacción
      await session.commitTransaction();
      session.endSession();
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error; // Re-throw para que el catch externo lo maneje
    }

    // 12. Agregar venta al historial de compras del cliente (fuera de la transacción)
      if (customer) {
        let hasNonVaccineProducts = false;

        for (const item of items) {
          if (item.type === 'producto') {
            const producto = await Producto.findById(item.item);
            if (producto) {
              const categoryName = await getCategoryName(producto.category);
              const isVaccineDewormer = isVaccineOrDewormer(categoryName);

              if (!isVaccineDewormer) {
                hasNonVaccineProducts = true;
                break;
              }
            }
          } else if (item.type === 'servicio') {
            hasNonVaccineProducts = true;
            break;
          }
        }

        if (hasNonVaccineProducts) {
          const Cliente = require('../models/Cliente');
          await Cliente.findByIdAndUpdate(
            customer,
            { $push: { purchaseHistory: ventaDoc._id } }
          );
        }
      }

    // Populate para respuesta
    await ventaDoc.populate('customer', 'name phone');
    await ventaDoc.populate('mascota', 'name type breed');
    await ventaDoc.populate('user', 'name');
    await ventaDoc.populate('items.item', 'name');

    res.status(201).json({
      success: true,
      data: ventaDoc
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
        message: 'Error al crear venta'
      });
  }
});

// @route   PUT /api/ventas/:id
// @desc    Actualizar venta con FIFO (solo status o notas para usuarios normales, campos sensibles solo para admin)
router.put('/:id', authenticateToken, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { status, notes, items, total, commission, discount, customer, mascota, amountReceived, change, paymentMethod, saleChannel, employeeDiscountApplied, employeeDiscountPercentage, payments, date, editOperationId, version } = req.body;

    // 1. Recuperar venta original
    const venta = await Venta.findById(req.params.id).session(session);
    if (!venta) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    }

    // 2. Generar operationId si no se proporciona
    const effectiveOperationId = editOperationId || uuidv4();

    // 3. Validar idempotencia
    const existingMovement = await InventoryMovement.findOne({ operationId: effectiveOperationId }).session(session);

    if (existingMovement) {
      const operationRecord = venta.operationHistory?.find(op => op.operationId === effectiveOperationId);

      if (!operationRecord) {
        await session.abortTransaction();
        session.endSession();
        return res.status(500).json({ success: false, message: 'Inconsistencia detectada en historial de operaciones' });
      }

      if (venta.version !== operationRecord.version) {
        await session.abortTransaction();
        session.endSession();
        return res.status(409).json({
          success: false,
          message: 'La venta fue modificada después de esta operación. Por favor recargue y vuelva a intentar.',
          currentVersion: venta.version,
          operationVersion: operationRecord.version
        });
      }

      await session.abortTransaction();
      session.endSession();
      return res.json({ success: true, data: venta, cached: true });
    }

    // 4. Validar versión (si se proporciona)
    if (version !== undefined && version !== venta.version) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        success: false,
        message: 'La venta fue modificada por otro usuario',
        currentVersion: venta.version,
        requestedVersion: version
      });
    }

    // Campos sensibles que solo admin puede modificar
    const sensitiveFields = ['items', 'total', 'commission', 'discount', 'customer', 'mascota', 'amountReceived', 'change', 'paymentMethod', 'saleChannel', 'employeeDiscountApplied', 'employeeDiscountPercentage', 'payments', 'date'];
    const hasSensitiveFields = sensitiveFields.some(field => req.body[field] !== undefined);

    if (hasSensitiveFields) {
      if (req.user.role !== 'admin') {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({
          success: false,
          message: 'No tienes permiso para modificar campos financieros de la venta'
        });
      }
      
      // Validación de relación cliente-mascota si se modifica
      if (mascota !== undefined && customer !== undefined) {
        if (mascota && !customer) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            success: false,
            message: 'Si se selecciona una mascota, debe seleccionar un cliente'
          });
        }

        if (mascota) {
          const mascotaDoc = await Mascota.findById(mascota).session(session);
          if (!mascotaDoc) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({
              success: false,
              message: 'Mascota no encontrada'
            });
          }

          if (!mascotaDoc.owner || mascotaDoc.owner.toString() !== customer) {
            await session.abortTransaction();
            session.endSession();
            return res.status(403).json({
              success: false,
              message: 'La mascota no pertenece al cliente seleccionado'
            });
          }
        }
      }
      
      // Admin puede modificar campos sensibles
      if (items) {
        // Validar que los servicios tengan mascota asociada
        for (const item of items) {
          if (item.type === 'servicio') {
            if (!item.mascota) {
              const servicio = await Servicio.findById(item.item).session(session);
              await session.abortTransaction();
              session.endSession();
              return res.status(400).json({
                success: false,
                message: `El servicio "${servicio ? servicio.name : 'desconocido'}" debe tener una mascota asociada`
              });
            }

            // Validar que la mascota pertenezca al cliente
            if (!customer && !venta.customer) {
              await session.abortTransaction();
              session.endSession();
              return res.status(400).json({
                success: false,
                message: 'Para vender servicios debe seleccionar un cliente'
              });
            }

            const effectiveCustomer = customer || venta.customer;
            const mascotaDoc = await Mascota.findById(item.mascota).session(session);
            if (!mascotaDoc) {
              await session.abortTransaction();
              session.endSession();
              return res.status(404).json({
                success: false,
                message: 'Mascota no encontrada'
              });
            }

            if (!mascotaDoc.owner || mascotaDoc.owner.toString() !== effectiveCustomer.toString()) {
              await session.abortTransaction();
              session.endSession();
              return res.status(403).json({
                success: false,
                message: `La mascota "${mascotaDoc.name}" no pertenece al cliente seleccionado`
              });
            }
          }
        }

        // 6. Si se modifican items, procesar FIFO
        if (items) {
          // 6.1 Revertir FIFO original
          await revertirFIFOEnVenta(venta._id, effectiveOperationId, req.user._id, session);

          // 6.2 Validar sincronización después de revertir
          await validarSincronizacionStockCapas(venta._id, session);

          // 6.3 Consumir nuevo estado FIFO
          await consumirFIFOEnVenta(items, venta._id, venta.date, req.user._id, effectiveOperationId, session);

          // 6.4 Validar sincronización después de consumir
          await validarSincronizacionStockCapas(venta._id, session);

          // 6.5 Si cambia de servicio o mascota, procesar historial médico y carnet
          if (mascota !== undefined || items !== undefined) {
            await revertirHistorialMedicoYCarnet(venta._id, effectiveOperationId, session);
            await actualizarHistorialMedicoYCarnet(venta, items, effectiveOperationId, session);
          }

          // 7. Actualizar campos de venta
          venta.items = items;
        }
      }
      if (paymentMethod !== undefined) venta.paymentMethod = paymentMethod;
      if (saleChannel !== undefined) venta.saleChannel = saleChannel;
      if (customer !== undefined) venta.customer = customer;
      if (mascota !== undefined) venta.mascota = mascota;
      if (amountReceived !== undefined) venta.amountReceived = amountReceived;
      if (change !== undefined) venta.change = change;
      if (employeeDiscountApplied !== undefined) venta.employeeDiscountApplied = employeeDiscountApplied;
      if (employeeDiscountPercentage !== undefined) venta.employeeDiscountPercentage = employeeDiscountPercentage;
      
      // Actualizar fecha si se proporciona (usando parseCalendarDate para evitar problemas de timezone)
      if (date !== undefined && date !== '') {
        const parsedDate = parseCalendarDate(date);
        if (parsedDate) {
          venta.date = parsedDate;
        }
      }
      
      // Si se modifican items o paymentMethod, recalcular totales en backend
      if (items || paymentMethod !== undefined) {
        // Calcular subtotal de cada item (usar subtotalBeforeDiscount si existe)
        venta.items.forEach(item => {
          item.subtotal = Math.round((item.subtotalBeforeDiscount || (item.quantity * item.unitPrice)) * 100) / 100;
        });
        
        // Calcular subtotal total
        venta.subtotal = Math.round(venta.items.reduce((sum, item) => sum + (item.subtotalBeforeDiscount || item.subtotal), 0) * 100) / 100;
        
        // Calcular descuento total
        const totalDiscount = venta.employeeDiscountApplied
          ? Math.round((venta.subtotal * (venta.employeeDiscountPercentage || 20) / 100) * 100) / 100
          : Math.round(venta.items.reduce((sum, item) => sum + (item.discountAmount || 0), 0) * 100) / 100;
        venta.totalDiscount = totalDiscount;
        
        // Calcular total después de descuentos
        const totalAfterDiscount = Math.round((venta.subtotal - totalDiscount) * 100) / 100;
        
        // Calcular comisión de tarjeta (4.06%) solo si paymentMethod es tarjeta
        if (venta.paymentMethod === 'tarjeta') {
          venta.cardCommission = Math.round((totalAfterDiscount * 0.0406) * 100) / 100;
        } else {
          venta.cardCommission = 0;
        }
        
        // Calcular total (subtotal después de descuentos sin comisión de tarjeta - la empresa absorbe la comisión)
        venta.total = totalAfterDiscount;
        
        // Calcular ingreso neto (total - commission - cardCommission)
        venta.netIncome = Math.round((venta.total - (venta.commission || 0) - venta.cardCommission) * 100) / 100;
      }
      
      // Si se envían manualmente, usar esos valores (solo admin puede hacerlo)
      if (total !== undefined) venta.total = total;
      if (commission !== undefined) venta.commission = commission;
      if (discount !== undefined) venta.discount = discount;
      
      // Validar payments[] si se envía
      if (payments !== undefined && payments.length > 0) {
        // Validar que cada pago tenga method y amount
        for (const payment of payments) {
          if (!payment.method || !['efectivo', 'tarjeta', 'transferencia'].includes(payment.method)) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              success: false,
              message: 'Método de pago inválido. Debe ser: efectivo, tarjeta o transferencia'
            });
          }
          if (payment.amount === undefined || payment.amount < 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              success: false,
              message: 'El monto de pago debe ser un número positivo'
            });
          }
        }
        
        // Calcular total de pagos
        const totalPayments = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
        const tolerance = 0.01;
        
        // Verificar si hay pagos en efectivo
        const hasCashPayment = payments.some(p => p.method === 'efectivo');
        
        if (hasCashPayment) {
          // Con efectivo, permitir sobrepago (el excedente será el cambio)
          if (totalPayments < venta.total - tolerance) {
            const missing = venta.total - totalPayments;
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              success: false,
              message: `Faltan $${missing.toFixed(2)} para completar el pago`
            });
          }
        } else {
          // Sin efectivo, el pago debe ser exacto
          if (Math.abs(totalPayments - venta.total) > tolerance) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              success: false,
              message: `La suma de pagos ($${totalPayments.toFixed(2)}) no coincide con el total de la venta ($${venta.total.toFixed(2)})`
            });
          }
        }
        
        // Guardar payments
        venta.payments = payments;
        
        // Calcular cambio si hay pagos en efectivo
        const cashPayments = payments.filter(p => p.method === 'efectivo');
        if (cashPayments.length > 0) {
          const totalCash = cashPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
          const nonCashTotal = payments.filter(p => p.method !== 'efectivo').reduce((sum, p) => sum + (p.amount || 0), 0);
          
          // El cambio es el excedente de efectivo sobre lo que corresponde pagar
          const cashRequired = venta.total - nonCashTotal;
          const calculatedChange = Math.round((totalCash - cashRequired) * 100) / 100;
          
          if (calculatedChange >= 0) {
            venta.amountReceived = totalCash;
            venta.change = calculatedChange;
          }
        }

      // 10. Actualizar campos de idempotencia
      venta.version = (venta.version || 0) + 1;
      venta.lastEditOperationId = effectiveOperationId;
      venta.operationHistory = venta.operationHistory || [];
      venta.operationHistory.push({
        operationId: effectiveOperationId,
        version: venta.version,
        timestamp: new Date(),
        userId: req.user._id
      });
    }

    // 11. Campos no sensibles (cualquier usuario)
    if (status) venta.status = status;
    if (notes !== undefined) venta.notes = notes;

    // 12. Guardar venta
    await venta.save({ session });

    // 13. Commit de la transacción
    await session.commitTransaction();
    session.endSession();

    // 14. Responder
    await venta.populate('customer', 'name phone');
    await venta.populate('mascota', 'name type breed');
    await venta.populate('user', 'name');

    res.json({
      success: true,
      data: venta
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar venta'
    });
  }
});

// @route   DELETE /api/ventas/:id
// @desc    Cancelar venta y devolver stock (solo admin)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const venta = await Venta.findById(req.params.id);
    
    if (!venta) {
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }

    if (venta.status === 'cancelada') {
      return res.status(400).json({
        success: false,
        message: 'La venta ya está cancelada'
      });
    }

    // Devolver stock al inventario
    for (const item of venta.items) {
      if (item.type === 'producto') {
        const producto = await Producto.findById(item.item);
        if (producto) {
          producto.stock += item.quantity;
          await producto.save();
        }
      }
    }

    // Actualizar status
    venta.status = 'cancelada';
    await venta.save();

    res.json({
      success: true,
      message: 'Venta cancelada y stock devuelto'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al cancelar venta'
    });
  }
});

// @route   GET /api/ventas/daily/:date
// @desc    Obtener ventas del día
router.get('/daily/:date', async (req, res) => {
  try {
    const date = new Date(req.params.date);
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const ventas = await Venta.find({
      date: { $gte: startDate, $lte: endDate },
      status: 'completada'
    }).populate('customer', 'name');

    const total = ventas.reduce((sum, venta) => sum + venta.total, 0);
    const commission = ventas.reduce((sum, venta) => sum + venta.commission, 0);
    const netIncome = ventas.reduce((sum, venta) => sum + venta.netIncome, 0);

    res.json({
      success: true,
      data: {
        date: req.params.date,
        ventas,
        summary: {
          totalVentas: ventas.length,
          totalSales: total,
          totalCommission: commission,
          totalNetIncome: netIncome
        }
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener ventas del día'
    });
  }
});

module.exports = router;

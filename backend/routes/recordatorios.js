const express = require('express');
const Recordatorio = require('../models/Recordatorio');
const CuentaPorPagar = require('../models/CuentaPorPagar');
const CarnetVacunacion = require('../models/CarnetVacunacion');
const Mascota = require('../models/Mascota');
const Producto = require('../models/Producto');
const { getCurrentDateGMT7 } = require('../helpers/timezone');
const mongoose = require('mongoose');
const { construirBandeja, quien, hoyTepic, diaDe, proximaDosisEfectiva } = require('../helpers/recordatoriosBandeja');
const { detallePago } = require('../helpers/recordatorioPago');
const router = express.Router();

// @route   GET /api/recordatorios
// @desc    Obtener todos los recordatorios
router.get('/', async (req, res) => {
  try {
    const { type, status, priority, date, page = 1, limit = 10 } = req.query;
    let query = {};

    if (type) query.type = type;
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      query.date = { $gte: startDate, $lt: endDate };
    }

    const recordatorios = await Recordatorio.find(query)
      .populate('user', 'name')
      .sort({ date: 1, priority: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Recordatorio.countDocuments(query);

    res.json({
      success: true,
      data: recordatorios,
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
      message: 'Error al obtener recordatorios'
    });
  }
});

// @route   GET /api/recordatorios/upcoming
// @desc    Obtener recordatorios próximos (próximos 7 días)
router.get('/upcoming', async (req, res) => {
  try {
    const { getCurrentDateGMT7 } = require('../helpers/timezone');
    const today = getCurrentDateGMT7();
    const next7Days = new Date(today);
    next7Days.setDate(next7Days.getDate() + 7);
    
    const recordatorios = await Recordatorio.find({
      status: 'pendiente',
      date: { $gte: today, $lte: next7Days }
    })
      .populate('user', 'name')
      .sort({ date: 1, priority: -1 });

    res.json({
      success: true,
      data: recordatorios
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener recordatorios próximos'
    });
  }
});

// @route   GET /api/recordatorios/overdue
// @desc    Obtener recordatorios vencidos
router.get('/overdue', async (req, res) => {
  try {
    const { getCurrentDateGMT7 } = require('../helpers/timezone');
    const today = getCurrentDateGMT7();
    
    const recordatorios = await Recordatorio.find({
      status: 'pendiente',
      date: { $lt: today }
    })
      .populate('user', 'name')
      .sort({ date: 1, priority: -1 });

    res.json({
      success: true,
      data: recordatorios
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener recordatorios vencidos'
    });
  }
});

// @route   GET /api/recordatorios/pending
// @desc    Obtener todos los recordatorios pendientes (incluyendo vencidos)
router.get('/pending', async (req, res) => {
  try {
    const recordatorios = await Recordatorio.find({
      status: 'pendiente'
    })
      .populate('user', 'name')
      .sort({ date: 1, priority: -1 });

    res.json({
      success: true,
      data: recordatorios
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener recordatorios pendientes'
    });
  }
});

// @route   GET /api/recordatorios/dashboard
// @desc    Obtener recordatorios para el Dashboard (cuentas, vacunas, stock bajo)
router.get('/dashboard', async (req, res) => {
  try {
    const today = getCurrentDateGMT7();
    today.setUTCHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    console.log('[Dashboard] Today (GMT-7):', today.toISOString());

    // 1. Cuentas por pagar pendientes (saldo > 0 y status != 'pagado')
    const cuentas = await CuentaPorPagar.find({
      $or: [
        { status: 'pendiente' },
        { status: 'vencido' }
      ],
      saldo: { $gt: 0 }
    })
      .populate('proveedor', 'name')
      .sort({ dueDate: 1 });

    console.log('[Dashboard] Cuentas encontradas:', cuentas.length);
    console.log('[Dashboard] Cuentas:', JSON.stringify(cuentas.map(c => ({ id: c._id, status: c.status, saldo: c.saldo, dueDate: c.dueDate }))));

    const cuentasReminders = [];
    
    for (const cuenta of cuentas) {
      const dueDate = new Date(cuenta.dueDate);
      dueDate.setUTCHours(0, 0, 0, 0);
      
      let urgency = 'proxima';
      let urgencyText = 'Próxima';
      
      if (dueDate < today) {
        urgency = 'vencida';
        urgencyText = 'Vencida';
      } else if (dueDate.getTime() === today.getTime()) {
        urgency = 'hoy';
        urgencyText = 'Vence hoy';
      } else if (dueDate.getTime() === tomorrow.getTime()) {
        urgency = 'manana';
        urgencyText = 'Vence mañana';
      } else if (dueDate <= nextWeek) {
        urgency = 'proxima';
        urgencyText = 'Próxima';
      }
      
      cuentasReminders.push({
        id: cuenta._id,
        type: 'cuenta_por_pagar',
        title: cuenta.proveedor?.name || 'Proveedor',
        description: `Saldo: $${cuenta.saldo.toFixed(2)}`,
        date: cuenta.dueDate,
        urgency,
        urgencyText,
        priority: urgency === 'vencida' ? 'alta' : urgency === 'hoy' ? 'alta' : urgency === 'manana' ? 'media' : 'baja',
        amount: cuenta.saldo,
        relatedId: cuenta._id,
        relatedType: 'CuentaPorPagar'
      });
    }

    // 2. Vacunas próximas (no vencidas)
    const carnets = await CarnetVacunacion.find()
      .populate('mascota')
      .populate('vacunas.vacuna');

    console.log('[Dashboard] Carnets encontrados:', carnets.length);

    const vacunasReminders = [];
    
    for (const carnet of carnets) {
      if (!carnet.mascota) continue;
      
      for (const vacuna of carnet.vacunas) {
        if (!vacuna.proximaDosis) continue;
        
        const proximaDosis = new Date(proximaDosisEfectiva(vacuna));
        proximaDosis.setUTCHours(0, 0, 0, 0);
        
        // Solo mostrar vacunas que no están vencidas
        if (proximaDosis < today) continue;
        
        let urgency = 'proxima';
        let urgencyText = 'Próxima';
        
        if (proximaDosis.getTime() === today.getTime()) {
          urgency = 'hoy';
          urgencyText = 'Hoy';
        } else if (proximaDosis.getTime() === tomorrow.getTime()) {
          urgency = 'manana';
          urgencyText = 'Mañana';
        } else if (proximaDosis <= nextWeek) {
          urgency = 'proxima';
          urgencyText = 'Próxima';
        }
        
        vacunasReminders.push({
          id: `${carnet._id}-${vacuna._id}`,
          type: 'vacuna',
          title: vacuna.vacuna?.nombre || vacuna.nombre || 'Vacuna',
          description: `Mascota: ${carnet.mascota.nombre}`,
          date: proximaDosisEfectiva(vacuna),
          urgency,
          urgencyText,
          priority: urgency === 'hoy' ? 'alta' : urgency === 'manana' ? 'media' : 'baja',
          relatedId: carnet._id,
          relatedType: 'CarnetVacunacion',
          vacunaId: vacuna._id,
          mascotaId: carnet.mascota._id,
          mascotaNombre: carnet.mascota.nombre
        });
      }
    }

    console.log('[Dashboard] Vacunas encontradas:', vacunasReminders.length);

    // 3. Productos con stock bajo
    const productosLowStock = await Producto.find({
      isActive: true,
      $expr: { $lt: ['$stock', '$minStock'] }
    }).sort({ stock: 1 });

    console.log('[Dashboard] Productos low stock encontrados:', productosLowStock.length);

    const productosReminders = productosLowStock.map(producto => ({
      id: producto._id,
      type: 'producto',
      title: producto.name,
      description: `Stock: ${producto.stock} (Mínimo: ${producto.minStock})`,
      urgency: 'baja',
      urgencyText: 'Stock bajo',
      priority: 'media',
      relatedId: producto._id,
      relatedType: 'Producto',
      stock: producto.stock,
      minStock: producto.minStock,
      sku: producto.sku
    }));

    // Ordenar cuentas por urgencia
    const urgencyOrder = { 'vencida': 0, 'hoy': 1, 'manana': 2, 'proxima': 3 };
    cuentasReminders.sort((a, b) => {
      if (urgencyOrder[a.urgency] !== urgencyOrder[b.urgency]) {
        return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
      }
      return new Date(a.date) - new Date(b.date);
    });

    // Ordenar vacunas por fecha
    vacunasReminders.sort((a, b) => new Date(a.date) - new Date(b.date));

    console.log('[Dashboard] Respuesta:', {
      accounts: cuentasReminders.length,
      vaccines: vacunasReminders.length,
      lowStockProducts: productosReminders.length
    });

    res.json({
      success: true,
      data: {
        accounts: cuentasReminders,
        vaccines: vacunasReminders,
        lowStockProducts: productosReminders,
        counts: {
          accounts: cuentasReminders.length,
          vaccines: vacunasReminders.length,
          lowStockProducts: productosReminders.length
        }
      }
    });
  } catch (error) {
    console.error('[Dashboard] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener recordatorios del dashboard',
      error: error.message
    });
  }
});

// @route   GET /api/recordatorios/bandeja?vista=pendientes|completados|todos
// @desc    Recordatorios manuales + próximas dosis del carnet, con estado calculado
//          (retrasado / hoy / pendiente / completado). Los retrasados NO se ocultan.
router.get('/bandeja', async (req, res) => {
  try {
    const vista = ['pendientes', 'completados', 'todos'].includes(req.query.vista) ? req.query.vista : 'pendientes';
    const data = await construirBandeja({ vista });
    res.json({ success: true, data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al obtener recordatorios' });
  }
});

// @route   PATCH /api/recordatorios/carnet/:carnetId/:aplicacionId/atender
// @desc    Completar el recordatorio de próxima dosis de una aplicación del carnet.
//          Solo escribe el campo "atendido" de ESA aplicación; no toca nada más del carnet.
router.patch('/carnet/:carnetId/:aplicacionId/atender', async (req, res) => {
  await marcarAplicacion(req, res, 'atendido', 'El recordatorio ya estaba completado', 'Recordatorio completado');
});

// @route   PATCH /api/recordatorios/carnet/:carnetId/:aplicacionId/notificar-dueno
// @desc    Registrar que se avisó al dueño. NO completa el recordatorio.
router.patch('/carnet/:carnetId/:aplicacionId/notificar-dueno', async (req, res) => {
  await marcarAplicacion(req, res, 'duenoNotificado', 'Ya se había registrado el aviso al dueño', 'Aviso al dueño registrado');
});

// @route   POST /api/recordatorios/carnet/:carnetId/:aplicacionId/aplicar
// @desc    "Se aplicó aquí": agrega la NUEVA aplicación al carnet (mismo producto y tipo que la anterior)
//          y marca como atendido el recordatorio de la anterior, en un solo guardado.
//          Body: { fecha?: 'AAAA-MM-DD' (hoy por defecto, no futura), diasProximaDosis?: número, observaciones? }
//          No toca inventario: lo que se cobra se registra en Ventas (que también llena el carnet).
router.post('/carnet/:carnetId/:aplicacionId/aplicar', async (req, res) => {
  try {
    const { carnetId, aplicacionId } = req.params;
    if (!mongoose.isValidObjectId(carnetId) || !mongoose.isValidObjectId(aplicacionId)) {
      return res.status(400).json({ success: false, message: 'Identificador inválido' });
    }
    const { fecha, diasProximaDosis, observaciones } = req.body || {};
    const hoy = hoyTepic();
    if (fecha !== undefined && fecha !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({ success: false, message: 'Fecha inválida' });
    }
    const dia = fecha || hoy;
    if (dia > hoy) return res.status(400).json({ success: false, message: 'La fecha de aplicación no puede ser futura' });
    const dias = diasProximaDosis === undefined || diasProximaDosis === null || diasProximaDosis === '' ? null : Number(diasProximaDosis);
    if (dias !== null && (!Number.isInteger(dias) || dias < 0 || dias > 3650)) {
      return res.status(400).json({ success: false, message: 'Días para la próxima dosis inválidos' });
    }

    const carnet = await CarnetVacunacion.findById(carnetId);
    if (!carnet) return res.status(404).json({ success: false, message: 'Carnet no encontrado' });
    const anterior = carnet.vacunas.id(aplicacionId);
    if (!anterior) return res.status(404).json({ success: false, message: 'Aplicación no encontrada en el carnet' });
    if (anterior.atendido?.fecha) return res.status(409).json({ success: false, message: 'El recordatorio ya estaba completado' });

    // Convención del sistema: hoy → hora actual de Tepic; otro día → mediodía de ese día
    const fechaAplicacion = dia === hoy ? getCurrentDateGMT7() : new Date(`${dia}T12:00:00Z`);
    const proximaDosis = dias ? new Date(new Date(`${dia}T12:00:00Z`).getTime() + dias * 86400000) : null;

    carnet.vacunas.push({
      vacuna: anterior.vacuna,
      nombre: anterior.nombre,
      tipo: anterior.tipo,
      fecha: fechaAplicacion,
      proximaDosis,
      diasProximaDosis: dias,
      observaciones: (observaciones || '').trim() || undefined
    });
    anterior.atendido = { fecha: new Date(), ...quien(req.user) };
    await carnet.save();

    const nueva = carnet.vacunas[carnet.vacunas.length - 1];
    res.status(201).json({ success: true, data: nueva, message: 'Aplicación registrada en el carnet' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al registrar la aplicación' });
  }
});

// @route   PATCH /api/recordatorios/carnet/:carnetId/:aplicacionId/reagendar
// @desc    Reagendar el recordatorio de próxima dosis. Body: { fecha: 'AAAA-MM-DD' (hoy o después), nota? }
//          NO cambia proximaDosis: agrega una entrada al historial "reagendado" de ESA aplicación.
router.patch('/carnet/:carnetId/:aplicacionId/reagendar', async (req, res) => {
  try {
    const { carnetId, aplicacionId } = req.params;
    if (!mongoose.isValidObjectId(carnetId) || !mongoose.isValidObjectId(aplicacionId)) {
      return res.status(400).json({ success: false, message: 'Identificador inválido' });
    }
    const { fecha, nota } = req.body || {};
    if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(new Date(`${fecha}T12:00:00Z`).getTime())) {
      return res.status(400).json({ success: false, message: 'Fecha inválida' });
    }
    if (fecha < hoyTepic()) return res.status(400).json({ success: false, message: 'La nueva fecha no puede ser anterior a hoy' });

    const carnet = await CarnetVacunacion.findOne({ _id: carnetId, 'vacunas._id': aplicacionId }).select('vacunas').lean();
    if (!carnet) return res.status(404).json({ success: false, message: 'Aplicación no encontrada en el carnet' });
    const ap = carnet.vacunas.find(v => String(v._id) === String(aplicacionId));
    if (!ap.proximaDosis) return res.status(400).json({ success: false, message: 'Esta aplicación no tiene próxima dosis' });
    if (ap.atendido?.fecha) return res.status(409).json({ success: false, message: 'El recordatorio ya estaba completado' });

    const anterior = proximaDosisEfectiva(ap);
    if (diaDe(anterior) === fecha) return res.status(400).json({ success: false, message: 'Es la misma fecha que ya tiene' });
    const entrada = {
      fecha: new Date(`${fecha}T12:00:00Z`),
      anterior,
      nota: typeof nota === 'string' && nota.trim() ? nota.trim().slice(0, 300) : undefined,
      ...quien(req.user),
      en: new Date()
    };
    // Atómico: solo si sigue sin completarse
    const r = await CarnetVacunacion.updateOne(
      { _id: carnetId },
      { $push: { 'vacunas.$[a].reagendado': entrada } },
      { arrayFilters: [{ 'a._id': new mongoose.Types.ObjectId(aplicacionId), 'a.atendido.fecha': { $exists: false } }] }
    );
    if (r.modifiedCount === 0) return res.status(409).json({ success: false, message: 'El recordatorio ya estaba completado' });
    res.json({ success: true, data: entrada, message: 'Recordatorio reagendado' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al reagendar el recordatorio' });
  }
});

async function marcarAplicacion(req, res, campo, msgYa, msgOk) {
  try {
    const { carnetId, aplicacionId } = req.params;
    if (!mongoose.isValidObjectId(carnetId) || !mongoose.isValidObjectId(aplicacionId)) {
      return res.status(400).json({ success: false, message: 'Identificador inválido' });
    }
    const carnet = await CarnetVacunacion.findOne({ _id: carnetId, 'vacunas._id': aplicacionId }).select('vacunas').lean();
    if (!carnet) return res.status(404).json({ success: false, message: 'Aplicación no encontrada en el carnet' });
    const ap = carnet.vacunas.find(v => String(v._id) === String(aplicacionId));
    if (!ap.proximaDosis) return res.status(400).json({ success: false, message: 'Esta aplicación no tiene próxima dosis' });

    const valor = { fecha: new Date(), ...quien(req.user) };
    // Condición atómica: solo si aún no tiene el dato (evita dobles clics y no sobrescribe el historial)
    const r = await CarnetVacunacion.updateOne(
      { _id: carnetId },
      { $set: { [`vacunas.$[a].${campo}`]: valor } },
      { arrayFilters: [{ 'a._id': new mongoose.Types.ObjectId(aplicacionId), [`a.${campo}.fecha`]: { $exists: false } }] }
    );
    if (r.modifiedCount === 0) return res.status(409).json({ success: false, message: msgYa });
    res.json({ success: true, data: valor, message: msgOk });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al actualizar el recordatorio' });
  }
}

// @route   GET /api/recordatorios/:id/detalle-pago
// @desc    Compra y cuenta por pagar de un recordatorio de pago (solo lectura)
router.get('/:id/detalle-pago', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Identificador inválido' });
    const r = await Recordatorio.findById(req.params.id).lean();
    if (!r) return res.status(404).json({ success: false, message: 'Recordatorio no encontrado' });
    if (r.type !== 'pago') return res.status(400).json({ success: false, message: 'Solo los recordatorios de pago tienen compra ligada' });
    res.json({ success: true, data: await detallePago(r) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al obtener el detalle del pago' });
  }
});

// @route   PATCH /api/recordatorios/:id/notificar-dueno
// @desc    Registrar que se avisó al dueño (recordatorios manuales de vacuna). NO lo completa.
router.patch('/:id/notificar-dueno', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Identificador inválido' });
    const actual = await Recordatorio.findById(req.params.id).select('type').lean();
    if (!actual) return res.status(404).json({ success: false, message: 'Recordatorio no encontrado' });
    if (actual.type !== 'vacuna') {
      return res.status(400).json({ success: false, message: 'El aviso al dueño solo aplica a vacunas y desparasitantes' });
    }
    const valor = { fecha: new Date(), ...quien(req.user) };
    const r = await Recordatorio.updateOne(
      { _id: req.params.id, 'duenoNotificado.fecha': { $exists: false } },
      { $set: { duenoNotificado: valor } }
    );
    if (r.modifiedCount === 0) return res.status(409).json({ success: false, message: 'Ya se había registrado el aviso al dueño' });
    res.json({ success: true, data: valor, message: 'Aviso al dueño registrado' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error al registrar el aviso' });
  }
});

// @route   GET /api/recordatorios/:id
// @desc    Obtener recordatorio por ID
router.get('/:id', async (req, res) => {
  try {
    const recordatorio = await Recordatorio.findById(req.params.id)
      .populate('user', 'name');
    
    if (!recordatorio) {
      return res.status(404).json({
        success: false,
        message: 'Recordatorio no encontrado'
      });
    }
    
    res.json({
      success: true,
      data: recordatorio
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener recordatorio'
    });
  }
});

// @route   POST /api/recordatorios
// @desc    Crear nuevo recordatorio
router.post('/', async (req, res) => {
  try {
    const recordatorio = await Recordatorio.create(req.body);
    await recordatorio.populate('user', 'name');
    
    res.status(201).json({
      success: true,
      data: recordatorio
    });
  } catch (error) {
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
      message: 'Error al crear recordatorio'
    });
  }
});

// @route   PUT /api/recordatorios/:id
// @desc    Actualizar recordatorio
router.put('/:id', async (req, res) => {
  try {
    const recordatorio = await Recordatorio.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('user', 'name');
    
    if (!recordatorio) {
      return res.status(404).json({
        success: false,
        message: 'Recordatorio no encontrado'
      });
    }
    
    res.json({
      success: true,
      data: recordatorio
    });
  } catch (error) {
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
      message: 'Error al actualizar recordatorio'
    });
  }
});

// @route   DELETE /api/recordatorios/:id
// @desc    Eliminar recordatorio
router.delete('/:id', async (req, res) => {
  try {
    const recordatorio = await Recordatorio.findByIdAndDelete(req.params.id);
    
    if (!recordatorio) {
      return res.status(404).json({
        success: false,
        message: 'Recordatorio no encontrado'
      });
    }
    
    res.json({
      success: true,
      message: 'Recordatorio eliminado correctamente'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar recordatorio'
    });
  }
});

// @route   PATCH /api/recordatorios/:id/complete
// @desc    Marcar recordatorio como completado
router.patch('/:id/complete', async (req, res) => {
  try {
    const recordatorio = await Recordatorio.findById(req.params.id);
    
    if (!recordatorio) {
      return res.status(404).json({
        success: false,
        message: 'Recordatorio no encontrado'
      });
    }

    if (recordatorio.status === 'completado') {
      return res.status(400).json({
        success: false,
        message: 'El recordatorio ya está completado'
      });
    }

    await recordatorio.complete(req.user);
    await recordatorio.populate('user', 'name');

    res.json({
      success: true,
      data: recordatorio,
      message: 'Recordatorio marcado como completado'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al completar recordatorio'
    });
  }
});

// @route   GET /api/recordatorios/calendar/:year/:month
// @desc    Obtener recordatorios para vista de calendario
router.get('/calendar/:year/:month', async (req, res) => {
  try {
    const { year, month } = req.params;
    
    const startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
    const endDate = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59, 999);
    
    const recordatorios = await Recordatorio.find({
      date: { $gte: startDate, $lte: endDate },
      status: 'pendiente'
    })
      .populate('user', 'name')
      .sort({ date: 1, priority: -1 });

    res.json({
      success: true,
      data: {
        year: parseInt(year),
        month: parseInt(month),
        recordatorios
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener recordatorios del calendario'
    });
  }
});

// @route   GET /api/recordatorios/automatic/accounts
// @desc    Obtener recordatorios automáticos de cuentas por pagar
router.get('/automatic/accounts', async (req, res) => {
  try {
    const { getCurrentDateGMT7 } = require('../helpers/timezone');
    const today = getCurrentDateGMT7();
    today.setUTCHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    const cuentas = await CuentaPorPagar.find({
      $or: [
        { status: 'pendiente' },
        { status: 'vencido' }
      ],
      saldo: { $gt: 0 }
    })
      .populate('proveedor', 'name')
      .sort({ dueDate: 1 });

    const recordatorios = [];
    
    for (const cuenta of cuentas) {
      const dueDate = new Date(cuenta.dueDate);
      dueDate.setUTCHours(0, 0, 0, 0);
      
      let urgency = 'proxima';
      let urgencyText = 'Próxima';
      
      if (dueDate < today) {
        urgency = 'vencida';
        urgencyText = 'Vencida';
      } else if (dueDate.getTime() === today.getTime()) {
        urgency = 'hoy';
        urgencyText = 'Vence hoy';
      } else if (dueDate.getTime() === tomorrow.getTime()) {
        urgency = 'manana';
        urgencyText = 'Vence mañana';
      } else if (dueDate <= nextWeek) {
        urgency = 'proxima';
        urgencyText = 'Próxima';
      }
      
      recordatorios.push({
        id: cuenta._id,
        type: 'cuenta_por_pagar',
        title: `Cuenta: ${cuenta.proveedor?.name || 'Proveedor'}`,
        description: `Saldo: $${cuenta.saldo.toFixed(2)}`,
        date: cuenta.dueDate,
        urgency,
        urgencyText,
        priority: urgency === 'vencida' ? 'alta' : urgency === 'hoy' ? 'alta' : urgency === 'manana' ? 'media' : 'baja',
        amount: cuenta.saldo,
        relatedId: cuenta._id,
        relatedType: 'CuentaPorPagar'
      });
    }

    // Ordenar por urgencia y fecha
    const urgencyOrder = { 'vencida': 0, 'hoy': 1, 'manana': 2, 'proxima': 3 };
    recordatorios.sort((a, b) => {
      if (urgencyOrder[a.urgency] !== urgencyOrder[b.urgency]) {
        return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
      }
      return new Date(a.date) - new Date(b.date);
    });

    res.json({
      success: true,
      data: recordatorios
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener recordatorios de cuentas por pagar'
    });
  }
});

// @route   GET /api/recordatorios/automatic/vaccines
// @desc    Obtener recordatorios automáticos de vacunas
router.get('/automatic/vaccines', async (req, res) => {
  try {
    const { getCurrentDateGMT7 } = require('../helpers/timezone');
    const today = getCurrentDateGMT7();
    today.setUTCHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    const carnets = await CarnetVacunacion.find()
      .populate('mascota')
      .populate('vacunas.vacuna');

    const recordatorios = [];
    
    for (const carnet of carnets) {
      if (!carnet.mascota) continue;
      
      for (const vacuna of carnet.vacunas) {
        if (!vacuna.proximaDosis) continue;
        
        const proximaDosis = new Date(proximaDosisEfectiva(vacuna));
        proximaDosis.setUTCHours(0, 0, 0, 0);
        
        let urgency = 'proxima';
        let urgencyText = 'Próxima';
        
        if (proximaDosis < today) {
          urgency = 'vencida';
          urgencyText = 'Vencida';
        } else if (proximaDosis.getTime() === today.getTime()) {
          urgency = 'hoy';
          urgencyText = 'Vence hoy';
        } else if (proximaDosis.getTime() === tomorrow.getTime()) {
          urgency = 'manana';
          urgencyText = 'Vence mañana';
        } else if (proximaDosis <= nextWeek) {
          urgency = 'proxima';
          urgencyText = 'Próxima';
        }
        
        recordatorios.push({
          id: `${carnet._id}-${vacuna._id}`,
          type: 'vacuna',
          title: `Vacuna: ${vacuna.vacuna?.nombre || vacuna.nombre || 'Vacuna'}`,
          description: `Mascota: ${carnet.mascota.nombre}`,
          date: proximaDosisEfectiva(vacuna),
          urgency,
          urgencyText,
          priority: urgency === 'vencida' ? 'alta' : urgency === 'hoy' ? 'alta' : urgency === 'manana' ? 'media' : 'baja',
          relatedId: carnet._id,
          relatedType: 'CarnetVacunacion',
          vacunaId: vacuna._id,
          mascotaId: carnet.mascota._id
        });
      }
    }

    // Ordenar por urgencia y fecha
    const urgencyOrder = { 'vencida': 0, 'hoy': 1, 'manana': 2, 'proxima': 3 };
    recordatorios.sort((a, b) => {
      if (urgencyOrder[a.urgency] !== urgencyOrder[b.urgency]) {
        return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
      }
      return new Date(a.date) - new Date(b.date);
    });

    res.json({
      success: true,
      data: recordatorios
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener recordatorios de vacunas'
    });
  }
});

// @route   GET /api/recordatorios/automatic/all
// @desc    Obtener todos los recordatorios automáticos (cuentas y vacunas)
router.get('/automatic/all', async (req, res) => {
  try {
    // Antes se llamaba a sí mismo por HTTP SIN la sesión del usuario: siempre recibía 401 y la
    // vista "Ver Automáticos" salía vacía. Ahora ejecuta los dos manejadores dentro del proceso.
    const ejecutar = (ruta) => new Promise((resolve, reject) => {
      const capa = router.stack.find(l => l.route && l.route.path === ruta && l.route.methods.get);
      const resFalso = { status() { return resFalso; }, json: resolve };
      Promise.resolve(capa.route.stack[0].handle(req, resFalso, reject)).catch(reject);
    });
    const [cuentas, vacunas] = await Promise.all([ejecutar('/automatic/accounts'), ejecutar('/automatic/vaccines')]);
    
    const allReminders = [
      ...(cuentas.success ? cuentas.data : []),
      ...(vacunas.success ? vacunas.data : [])
    ];
    
    // Ordenar por urgencia y fecha
    const urgencyOrder = { 'vencida': 0, 'hoy': 1, 'manana': 2, 'proxima': 3 };
    allReminders.sort((a, b) => {
      if (urgencyOrder[a.urgency] !== urgencyOrder[b.urgency]) {
        return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
      }
      return new Date(a.date) - new Date(b.date);
    });

    res.json({
      success: true,
      data: allReminders
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener recordatorios automáticos'
    });
  }
});

// @route   GET /api/recordatorios/dashboard
// @desc    Obtener recordatorios para el Dashboard (cuentas, vacunas, stock bajo)
router.get('/dashboard', async (req, res) => {
  try {
    const today = getCurrentDateGMT7();
    today.setUTCHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    console.log('[Dashboard] Today (GMT-7):', today.toISOString());

    // 1. Cuentas por pagar pendientes (saldo > 0 y status != 'pagado')
    const cuentas = await CuentaPorPagar.find({
      $or: [
        { status: 'pendiente' },
        { status: 'vencido' }
      ],
      saldo: { $gt: 0 }
    })
      .populate('proveedor', 'name')
      .sort({ dueDate: 1 });

    console.log('[Dashboard] Cuentas encontradas:', cuentas.length);
    console.log('[Dashboard] Cuentas:', JSON.stringify(cuentas.map(c => ({ id: c._id, status: c.status, saldo: c.saldo, dueDate: c.dueDate }))));

    const cuentasReminders = [];
    
    for (const cuenta of cuentas) {
      const dueDate = new Date(cuenta.dueDate);
      dueDate.setUTCHours(0, 0, 0, 0);
      
      let urgency = 'proxima';
      let urgencyText = 'Próxima';
      
      if (dueDate < today) {
        urgency = 'vencida';
        urgencyText = 'Vencida';
      } else if (dueDate.getTime() === today.getTime()) {
        urgency = 'hoy';
        urgencyText = 'Vence hoy';
      } else if (dueDate.getTime() === tomorrow.getTime()) {
        urgency = 'manana';
        urgencyText = 'Vence mañana';
      } else if (dueDate <= nextWeek) {
        urgency = 'proxima';
        urgencyText = 'Próxima';
      }
      
      cuentasReminders.push({
        id: cuenta._id,
        type: 'cuenta_por_pagar',
        title: cuenta.proveedor?.name || 'Proveedor',
        description: `Saldo: $${cuenta.saldo.toFixed(2)}`,
        date: cuenta.dueDate,
        urgency,
        urgencyText,
        priority: urgency === 'vencida' ? 'alta' : urgency === 'hoy' ? 'alta' : urgency === 'manana' ? 'media' : 'baja',
        amount: cuenta.saldo,
        relatedId: cuenta._id,
        relatedType: 'CuentaPorPagar'
      });
    }

    // 2. Vacunas próximas (no vencidas)
    const carnets = await CarnetVacunacion.find()
      .populate('mascota')
      .populate('vacunas.vacuna');

    console.log('[Dashboard] Carnets encontrados:', carnets.length);

    const vacunasReminders = [];
    
    for (const carnet of carnets) {
      if (!carnet.mascota) continue;
      
      for (const vacuna of carnet.vacunas) {
        if (!vacuna.proximaDosis) continue;
        
        const proximaDosis = new Date(proximaDosisEfectiva(vacuna));
        proximaDosis.setUTCHours(0, 0, 0, 0);
        
        // Solo mostrar vacunas que no están vencidas
        if (proximaDosis < today) continue;
        
        let urgency = 'proxima';
        let urgencyText = 'Próxima';
        
        if (proximaDosis.getTime() === today.getTime()) {
          urgency = 'hoy';
          urgencyText = 'Hoy';
        } else if (proximaDosis.getTime() === tomorrow.getTime()) {
          urgency = 'manana';
          urgencyText = 'Mañana';
        } else if (proximaDosis <= nextWeek) {
          urgency = 'proxima';
          urgencyText = 'Próxima';
        }
        
        vacunasReminders.push({
          id: `${carnet._id}-${vacuna._id}`,
          type: 'vacuna',
          title: vacuna.vacuna?.nombre || vacuna.nombre || 'Vacuna',
          description: `Mascota: ${carnet.mascota.nombre}`,
          date: proximaDosisEfectiva(vacuna),
          urgency,
          urgencyText,
          priority: urgency === 'hoy' ? 'alta' : urgency === 'manana' ? 'media' : 'baja',
          relatedId: carnet._id,
          relatedType: 'CarnetVacunacion',
          vacunaId: vacuna._id,
          mascotaId: carnet.mascota._id,
          mascotaNombre: carnet.mascota.nombre
        });
      }
    }

    console.log('[Dashboard] Vacunas encontradas:', vacunasReminders.length);

    // 3. Productos con stock bajo
    const productosLowStock = await Producto.find({
      isActive: true,
      $expr: { $lt: ['$stock', '$minStock'] }
    }).sort({ stock: 1 });

    console.log('[Dashboard] Productos low stock encontrados:', productosLowStock.length);

    const productosReminders = productosLowStock.map(producto => ({
      id: producto._id,
      type: 'producto',
      title: producto.name,
      description: `Stock: ${producto.stock} (Mínimo: ${producto.minStock})`,
      urgency: 'baja',
      urgencyText: 'Stock bajo',
      priority: 'media',
      relatedId: producto._id,
      relatedType: 'Producto',
      stock: producto.stock,
      minStock: producto.minStock,
      sku: producto.sku
    }));

    // Ordenar cuentas por urgencia
    const urgencyOrder = { 'vencida': 0, 'hoy': 1, 'manana': 2, 'proxima': 3 };
    cuentasReminders.sort((a, b) => {
      if (urgencyOrder[a.urgency] !== urgencyOrder[b.urgency]) {
        return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
      }
      return new Date(a.date) - new Date(b.date);
    });

    // Ordenar vacunas por fecha
    vacunasReminders.sort((a, b) => new Date(a.date) - new Date(b.date));

    console.log('[Dashboard] Respuesta:', {
      accounts: cuentasReminders.length,
      vaccines: vacunasReminders.length,
      lowStockProducts: productosReminders.length
    });

    res.json({
      success: true,
      data: {
        accounts: cuentasReminders,
        vaccines: vacunasReminders,
        lowStockProducts: productosReminders,
        counts: {
          accounts: cuentasReminders.length,
          vaccines: vacunasReminders.length,
          lowStockProducts: productosReminders.length
        }
      }
    });
  } catch (error) {
    console.error('[Dashboard] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener recordatorios del dashboard',
      error: error.message
    });
  }
});

module.exports = router;

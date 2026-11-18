/**
 * Detalle de un recordatorio de pago: la cuenta por pagar ligada y la compra que la originó.
 * Solo lectura. Si el recordatorio es viejo y no tiene el campo cuentaPorPagar, la cuenta se
 * busca igual que en la migración de liga (compra recuperada o folio de la descripción), sin escribir nada.
 */
const mongoose = require('mongoose');
const CuentaPorPagar = require('../models/CuentaPorPagar');
const Compra = require('../models/Compra');

const RE_DESCRIPCION = /compra\s+(\S+)\s+por\s+\$/i;

// Cuentas que podrían corresponder a un recordatorio de pago SIN liga.
async function cuentasCandidatas(r) {
  const recuperada = await Compra.findOne({ 'recuperada.recordatorio': r._id }).select('_id').lean();
  if (recuperada) {
    const c = await CuentaPorPagar.find({ compra: recuperada._id }).lean();
    if (c.length) return c;
  }
  const m = (r.description || '').match(RE_DESCRIPCION);
  if (!m) return [];
  const token = m[1];
  const or = [{ receiptNumber: token }];
  if (mongoose.isValidObjectId(token)) or.push({ compra: new mongoose.Types.ObjectId(token) });
  const filtro = { $or: or };
  if (r.relatedModel === 'Proveedor' && r.relatedId) filtro.proveedor = r.relatedId;
  return CuentaPorPagar.find(filtro).lean();
}

/**
 * @returns {{ liga: 'directa'|'deducida'|'ninguna'|'ambigua', cuenta, compra }}
 */
async function detallePago(recordatorio) {
  let cuentaId = recordatorio.cuentaPorPagar || null;
  let liga = cuentaId ? 'directa' : 'ninguna';
  if (!cuentaId) {
    const c = await cuentasCandidatas(recordatorio);
    if (c.length === 1) { cuentaId = c[0]._id; liga = 'deducida'; } else if (c.length > 1) liga = 'ambigua';
  }
  if (!cuentaId) return { liga, cuenta: null, compra: null };

  const cuenta = await CuentaPorPagar.findById(cuentaId)
    .populate('proveedor', 'name phone contact')
    .populate('payments.user', 'name')
    .lean();
  if (!cuenta) return { liga: 'ninguna', cuenta: null, compra: null };

  const compra = cuenta.compra
    ? await Compra.findById(cuenta.compra)
      .select('date type status total baseTotal totalDiscount invoice notes dueDate items recuperada user')
      .populate('items.product', 'name sku')
      .populate('user', 'name')
      .lean()
    : null;

  return {
    liga,
    cuenta: {
      _id: cuenta._id,
      proveedor: cuenta.proveedor ? { nombre: cuenta.proveedor.name, telefono: cuenta.proveedor.phone || null } : null,
      folio: cuenta.receiptNumber || null,
      status: cuenta.status,
      monto: cuenta.monto,
      saldo: cuenta.saldo,
      pagado: (cuenta.payments || []).reduce((s, p) => s + (p.amount || 0), 0),
      vence: cuenta.dueDate,
      descuentoDisponible: cuenta.descuentoDisponible || 0,
      fechaLimiteDescuento: cuenta.discountDeadline || null,
      pagos: (cuenta.payments || []).map(p => ({ monto: p.amount, fecha: p.date, metodo: p.paymentMethod, usuario: p.user?.name || null, notas: p.notes || '' })),
      notas: cuenta.notes || ''
    },
    compra: compra ? {
      _id: compra._id,
      fecha: compra.date,
      tipo: compra.type,
      status: compra.status,
      total: compra.total,
      subtotal: compra.baseTotal,
      descuento: compra.totalDiscount || 0,
      factura: compra.invoice || null,
      notas: compra.notes || '',
      registradaPor: compra.user?.name || null,
      recuperada: !!compra.recuperada?.origen,
      productos: (compra.items || []).map(i => ({
        nombre: i.product?.name || 'Producto eliminado',
        sku: i.product?.sku || null,
        cantidad: i.quantity,
        costoUnitario: i.unitCost,
        subtotal: i.subtotal
      }))
    } : null
  };
}

module.exports = { detallePago, cuentasCandidatas };

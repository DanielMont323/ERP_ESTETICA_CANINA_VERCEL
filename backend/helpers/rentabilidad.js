/**
 * Estado de resultados por devengado (rentabilidad real de un periodo).
 *
 *   Ventas (productos + servicios)
 * − Comisiones (tarjeta, Mercado Libre / manuales)
 * = Ingreso neto
 * − Costo de lo vendido
 *     · productos: costo FIFO exacto de las capas consumidas (VERIFICADO)
 *       o, en ventas anteriores a FIFO, cantidad × costo actual del producto (ESTIMADO)
 *     · insumos de servicios: costo FIFO de los insumos consumidos (VERIFICADO)
 * = Utilidad bruta
 * − Gastos de operación (módulo Costos, por categoría)
 * = Utilidad de operación
 *
 * Las compras NO son costo: entran al inventario y se vuelven costo cuando se vende la mercancía.
 * Los gastos "mensuales" que no se capturaron en un mes del periodo se reportan aparte
 * (no se suman a la utilidad capturada; se muestra una utilidad ajustada con ellos).
 */
const Venta = require('../models/Venta');
const Costo = require('../models/Costo');
const Producto = require('../models/Producto');
const InventoryMovement = require('../models/InventoryMovement');
const { toGMT7 } = require('./timezone');
const { productoSinStock } = require('./productoSinStock');

const r2 = n => Math.round((n || 0) * 100) / 100;
const pct = (a, b) => (b > 0 ? r2((a / b) * 100) : 0);

// Importe de una línea de venta después de su descuento (con respaldo para ventas antiguas)
const importeLinea = item => {
  if (typeof item.subtotalAfterDiscount === 'number') return item.subtotalAfterDiscount;
  if (typeof item.subtotal === 'number') return item.subtotal;
  return (item.quantity || 0) * (item.unitPrice || 0);
};

// Costo vigente por venta y línea: salidas FIFO de la venta que no tienen reversión.
async function costosFifoPorVenta(ventaIds) {
  const salidas = await InventoryMovement.find({ sale: { $in: ventaIds }, type: 'salida' })
    .select('_id sale saleItemIndex totalCost source').lean();
  if (salidas.length === 0) return new Map();
  const revertidas = new Set((await InventoryMovement.find({ originalMovement: { $in: salidas.map(s => s._id) } })
    .select('originalMovement').lean()).map(r => String(r.originalMovement)));
  const porVenta = new Map(); // ventaId -> { productos: Map(itemIndex -> costo), servicios: costo }
  for (const s of salidas) {
    if (revertidas.has(String(s._id))) continue;
    const key = String(s.sale);
    if (!porVenta.has(key)) porVenta.set(key, { lineas: new Map(), insumos: 0 });
    const v = porVenta.get(key);
    if (s.source === 'servicio') v.insumos += s.totalCost || 0;
    else v.lineas.set(s.saleItemIndex, (v.lineas.get(s.saleItemIndex) || 0) + (s.totalCost || 0));
  }
  return porVenta;
}

// Gastos mensuales que no se capturaron en algún mes del periodo (solo hasta hoy).
async function recurrentesNoCapturados(rango, ahora) {
  const hoy = toGMT7(ahora);
  const limite = rango.end < hoy ? rango.end : hoy;
  const plantillas = await Costo.find({ isActive: true, frequency: 'mensual', date: { $lte: limite } })
    .sort({ date: 1 }).lean();
  if (plantillas.length === 0) return [];
  const norm = s => String(s || '').trim().toLowerCase();
  // Última plantilla por descripción
  const porDescripcion = new Map();
  for (const p of plantillas) porDescripcion.set(norm(p.description), p);

  const faltantes = [];
  for (const [desc, p] of porDescripcion) {
    const base = new Date(p.date);
    const dia = base.getUTCDate();
    let y = rango.start.getUTCFullYear();
    let m = rango.start.getUTCMonth();
    while (Date.UTC(y, m, 1) <= limite.getTime()) {
      const inicioMes = new Date(Date.UTC(y, m, 1));
      const finMes = new Date(Date.UTC(y, m + 1, 1) - 1);
      const diasMes = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const ocurrencia = new Date(Date.UTC(y, m, Math.min(dia, diasMes), 12));
      const posterior = inicioMes > new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
      if (posterior && ocurrencia >= rango.start && ocurrencia <= limite) {
        const capturados = await Costo.find({ isActive: true, date: { $gte: inicioMes, $lte: finMes } })
          .select('description').lean();
        if (!capturados.some(c => norm(c.description) === desc)) {
          faltantes.push({
            descripcion: p.description,
            categoria: p.category,
            monto: r2(p.amount),
            mes: `${y}-${String(m + 1).padStart(2, '0')}`,
            fechaEsperada: ocurrencia
          });
        }
      }
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
  }
  return faltantes.sort((a, b) => a.fechaEsperada - b.fechaEsperada);
}

async function calcularRentabilidad(rango, ahora = new Date()) {
  const filtroFecha = { date: { $gte: rango.start, $lte: rango.end } };
  const ventas = await Venta.find({ ...filtroFecha, status: 'completada' })
    .select('items total netIncome cardCommission commission saleChannel manualFinancials fifoTracked').lean();

  const costosFifo = await costosFifoPorVenta(ventas.map(v => v._id));

  // Costo actual de productos para estimar ventas anteriores a FIFO
  const idsProducto = new Set();
  for (const v of ventas) for (const it of v.items || []) if (it.type === 'producto' && it.item) idsProducto.add(String(it.item));
  const productosVendidos = await Producto.find({ _id: { $in: [...idsProducto] } }).select('cost category').lean();
  const costoActual = new Map(productosVendidos.map(p => [String(p._id), p.cost || 0]));
  // Plaquitas vendidas sobre pedido (sin existencias): no tienen salida FIFO; su costo es el del producto.
  const sinStock = new Set();
  for (const p of productosVendidos) if (await productoSinStock(p)) sinStock.add(String(p._id));

  const t = {
    ventasProductos: 0, ventasServicios: 0, total: 0, comisionTarjeta: 0, otrasComisiones: 0, ingresoNeto: 0,
    costoVerificado: 0, costoEstimado: 0, insumosServicios: 0, serviciosExternos: 0,
    lineasVerificadas: 0, lineasEstimadas: 0, lineasSobrePedido: 0, lineasSinCosto: 0,
    ventasFifo: 0, ventasHistoricas: 0
  };

  for (const v of ventas) {
    const total = v.total || 0;
    const neto = typeof v.netIncome === 'number' ? v.netIncome : total;
    const tarjeta = v.cardCommission || 0;
    // La comisión de tarjeta (4.06%) la absorbe la tienda (confirmado por el cliente 2026-11-12):
    // el cliente paga el total y el banco descuenta la comisión. Se resta igual que la de
    // Mercado Libre / comisión manual (netIncome guardado ya las descuenta).
    const otras = Math.max(0, total - neto - tarjeta);
    t.total += total;
    t.ingresoNeto += neto;
    t.comisionTarjeta += tarjeta;
    t.otrasComisiones += otras;

    // Reparte el total (ya con descuentos de empleado o ajuste manual) en proporción a cada línea
    const items = v.items || [];
    const sumaLineas = items.reduce((s, it) => s + importeLinea(it), 0);
    const factor = sumaLineas > 0 ? total / sumaLineas : 0;
    items.forEach(it => {
      const ingreso = importeLinea(it) * factor;
      if (it.type === 'servicio') t.ventasServicios += ingreso; else t.ventasProductos += ingreso;
    });
    if (sumaLineas === 0) t.ventasProductos += total;

    // Servicios con costo externo (laboratorio, rayos X): costo copiado en la línea al vender
    items.forEach(it => {
      if (it.type === 'servicio' && it.costoExterno > 0) t.serviciosExternos += it.costoExterno * (it.quantity || 0);
    });

    const fifo = costosFifo.get(String(v._id));
    if (fifo) {
      t.ventasFifo += 1;
      t.insumosServicios += fifo.insumos;
    } else {
      t.ventasHistoricas += 1;
    }
    items.forEach((it, idx) => {
      if (it.type !== 'producto') return;
      if (fifo && fifo.lineas.has(idx)) {
        t.costoVerificado += fifo.lineas.get(idx);
        t.lineasVerificadas += 1;
        return;
      }
      const unitario = costoActual.get(String(it.item)) || 0;
      if (unitario > 0) {
        t.costoEstimado += unitario * (it.quantity || 0);
        if (v.fifoTracked && sinStock.has(String(it.item))) t.lineasSobrePedido += 1;
        else t.lineasEstimadas += 1;
      } else {
        t.lineasSinCosto += 1;
      }
    });
  }

  // Gastos de operación por categoría
  const gastos = await Costo.find({ ...filtroFecha, isActive: true }).select('category amount type').lean();
  const porCategoria = new Map();
  for (const g of gastos) {
    const c = porCategoria.get(g.category) || { categoria: g.category, monto: 0, registros: 0 };
    c.monto += g.amount || 0;
    c.registros += 1;
    porCategoria.set(g.category, c);
  }
  const totalGastos = gastos.reduce((s, g) => s + (g.amount || 0), 0);
  const faltantes = await recurrentesNoCapturados(rango, ahora);
  const totalFaltantes = faltantes.reduce((s, f) => s + f.monto, 0);

  const costoProductos = t.costoVerificado + t.costoEstimado;
  const costoVentas = costoProductos + t.insumosServicios + t.serviciosExternos;
  const utilidadBruta = t.ingresoNeto - costoVentas;
  // Ajustes manuales de inventario del periodo: mermas/faltantes (salidas) menos sobrantes (entradas),
  // valuados al costo FIFO de las capas. Una merma es mercancía que se pagó y no se vendió.
  // Los ajustes anulados (por error) y sus anulaciones no cuentan: se excluyen ambos, aunque caigan en meses distintos.
  const ajustesPeriodo = await InventoryMovement.find({
    ...filtroFecha, source: 'ajuste', type: { $in: ['ajuste_entrada', 'ajuste_salida'] }, originalMovement: null
  }).select('type totalCost').lean();
  const anuladosAjuste = new Set((await InventoryMovement.find({ originalMovement: { $in: ajustesPeriodo.map(a => a._id) }, source: 'ajuste' })
    .select('originalMovement').lean()).map(a => String(a.originalMovement)));
  const ajustes = ajustesPeriodo.filter(a => !anuladosAjuste.has(String(a._id)));
  const mermas = ajustes.filter(a => a.type === 'ajuste_salida').reduce((s, a) => s + (a.totalCost || 0), 0);
  const sobrantes = ajustes.filter(a => a.type === 'ajuste_entrada').reduce((s, a) => s + (a.totalCost || 0), 0);
  const ajusteNeto = mermas - sobrantes;

  const utilidadOperacion = utilidadBruta - totalGastos - ajusteNeto;

  // Avisos para el dueño del negocio, en lenguaje sencillo (sin términos técnicos).
  // Los gastos mensuales pendientes se muestran en su propia lista, no aquí.
  const notas = [];
  if (t.lineasEstimadas > 0) {
    notas.push('El costo de los productos vendidos antes del 12 de noviembre de 2026 es aproximado: '
      + 'en esas fechas el sistema todavía no guardaba cuánto costó cada pieza vendida, así que se usa su costo actual. '
      + 'Las ventas desde el 12 de noviembre ya tienen su costo exacto.');
  }
  if (t.lineasSinCosto > 0) {
    notas.push(`${t.lineasSinCosto === 1 ? 'Un producto vendido no tiene' : `${t.lineasSinCosto} productos vendidos no tienen`} `
      + 'costo capturado; por eso la ganancia puede verse mayor a la real. Captura su costo en Productos.');
  }

  return {
    periodo: { start: rango.start, end: rango.end },
    ventas: {
      cantidad: ventas.length,
      total: r2(t.total),
      productos: r2(t.ventasProductos),
      servicios: r2(t.ventasServicios)
    },
    comisiones: {
      tarjeta: r2(t.comisionTarjeta),
      otras: r2(t.otrasComisiones),
      total: r2(t.comisionTarjeta + t.otrasComisiones)
    },
    ingresoNeto: r2(t.ingresoNeto),
    costoVentas: {
      productosVerificado: r2(t.costoVerificado),
      productosEstimado: r2(t.costoEstimado),
      productos: r2(costoProductos),
      insumosServicios: r2(t.insumosServicios),
      serviciosExternos: r2(t.serviciosExternos),
      total: r2(costoVentas)
    },
    utilidadBruta: r2(utilidadBruta),
    margenBruto: pct(utilidadBruta, t.ingresoNeto),
    margenProductos: {
      ingreso: r2(t.ventasProductos),
      costo: r2(costoProductos),
      utilidad: r2(t.ventasProductos - costoProductos),
      margen: pct(t.ventasProductos - costoProductos, t.ventasProductos)
    },
    gastos: {
      total: r2(totalGastos),
      porCategoria: [...porCategoria.values()].map(c => ({ ...c, monto: r2(c.monto) })).sort((a, b) => b.monto - a.monto),
      recurrentesNoCapturados: faltantes,
      totalRecurrentesNoCapturados: r2(totalFaltantes)
    },
    ajustesInventario: {
      mermas: r2(mermas),
      sobrantes: r2(sobrantes),
      neto: r2(ajusteNeto),
      registros: ajustes.length
    },
    utilidadOperacion: r2(utilidadOperacion),
    margenOperacion: pct(utilidadOperacion, t.ingresoNeto),
    utilidadOperacionAjustada: r2(utilidadOperacion - totalFaltantes),
    calidad: {
      ventasFifo: t.ventasFifo,
      ventasHistoricas: t.ventasHistoricas,
      lineasVerificadas: t.lineasVerificadas,
      lineasEstimadas: t.lineasEstimadas,
      lineasSobrePedido: t.lineasSobrePedido,
      lineasSinCosto: t.lineasSinCosto,
      pctCostoVerificado: pct(t.costoVerificado, costoProductos),
      notas
    }
  };
}

module.exports = { calcularRentabilidad, recurrentesNoCapturados };

// Etapa 4 — Estado de resultados por devengado (GET /api/reports/profitability).
const h = require('./helpers/app');
const mongoose = require('mongoose');
const Costo = require('../models/Costo');
const { hoyCalendarioTepic } = require('../helpers/timezone');
const { recurrentesNoCapturados } = require('../helpers/rentabilidad');
const { Venta } = h.models;

let admin, base;
const hoy = hoyCalendarioTepic().toISOString().slice(0, 10);
const rangoHoy = `?startDate=${hoy}&endDate=${hoy}`;
const linea = (p, quantity, unitPrice = 100) => ({ type: 'producto', item: p._id.toString(), quantity, unitPrice });
const reporte = async (q = rangoHoy, token = admin.token) => h.request(h.app).get('/api/reports/profitability' + q).set(h.auth(token));

beforeEach(async () => {
  await h.resetAislado();
  await Costo.deleteMany({});
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

test('el costo de lo vendido es el FIFO consumido, no las compras del periodo', async () => {
  const p = await h.producto();
  expect((await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 10, unitCost: 50 })).status).toBe(201);
  expect((await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 10, unitCost: 60 })).status).toBe(201);
  expect((await h.vender(admin.token, [linea(p, 12)])).status).toBe(201);
  await Costo.create({ description: 'Renta', type: 'fijo', amount: 300, category: 'renta', date: hoyCalendarioTepic() });

  const r = await reporte();
  expect(r.status).toBe(200);
  const d = r.body.data;
  expect(d.ventas.total).toBe(1200);
  expect(d.ventas.productos).toBe(1200);
  expect(d.costoVentas.productosVerificado).toBe(620); // 10×50 + 2×60 (las compras fueron $1,100)
  expect(d.costoVentas.productosEstimado).toBe(0);
  expect(d.utilidadBruta).toBe(580);
  expect(d.gastos.total).toBe(300);
  expect(d.gastos.porCategoria).toEqual([{ categoria: 'renta', monto: 300, registros: 1 }]);
  expect(d.utilidadOperacion).toBe(280);
  expect(d.calidad.pctCostoVerificado).toBe(100);
});

test('una venta anterior a FIFO usa el costo actual del producto y se marca como estimada', async () => {
  const p = await h.producto({ cost: 10 });
  const sinCosto = await h.producto({ cost: 0 });
  await Venta.create({
    items: [{ type: 'producto', item: p._id, quantity: 3, unitPrice: 50 }, { type: 'producto', item: sinCosto._id, quantity: 1, unitPrice: 40 }],
    paymentMethod: 'efectivo', saleChannel: 'local', status: 'completada'
  });
  const d = (await reporte()).body.data;
  expect(d.ventas.total).toBe(190);
  expect(d.costoVentas.productosEstimado).toBe(30);
  expect(d.costoVentas.productosVerificado).toBe(0);
  expect(d.calidad).toMatchObject({ ventasHistoricas: 1, ventasFifo: 0, lineasEstimadas: 1, lineasSinCosto: 1, pctCostoVerificado: 0 });
  expect(d.calidad.notas.join(' ')).toMatch(/aproximado/);
});

test('ventas canceladas no cuentan; una venta editada cuenta solo su costo vigente', async () => {
  const p = await h.producto();
  await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 10, unitCost: 50 });
  const cancelada = await h.vender(admin.token, [linea(p, 2)]);
  expect((await h.request(h.app).delete('/api/ventas/' + cancelada.body.data._id).set(h.auth(admin.token))).status).toBe(200);
  const v = await h.vender(admin.token, [linea(p, 4)]);
  const editada = await h.request(h.app).put('/api/ventas/' + v.body.data._id).set(h.auth(admin.token))
    .send({ items: [linea(p, 1)], payments: [{ method: 'transferencia', amount: 100 }], version: v.body.data.version });
  expect(editada.status).toBe(200);
  const d = (await reporte()).body.data;
  expect(d.ventas.cantidad).toBe(1);
  expect(d.costoVentas.productosVerificado).toBe(50);
});

test('la comisión de tarjeta la absorbe la tienda: se resta de lo que entró', async () => {
  await Venta.create({
    items: [{ type: 'servicio', item: new mongoose.Types.ObjectId(), quantity: 1, unitPrice: 1000 }],
    payments: [{ method: 'tarjeta', amount: 1000 }], saleChannel: 'local', status: 'completada'
  });
  const d = (await reporte()).body.data;
  expect(d.ventas.servicios).toBe(1000);
  expect(d.comisiones.tarjeta).toBe(40.6);
  expect(d.ingresoNeto).toBe(959.4);
});

test('la comisión de Mercado Libre sí se resta', async () => {
  await Venta.create({
    items: [{ type: 'producto', item: (await h.producto({ cost: 0 }))._id, quantity: 1, unitPrice: 500, subtotal: 500, subtotalAfterDiscount: 500 }],
    payments: [{ method: 'transferencia', amount: 500 }], saleChannel: 'mercado_libre', manualFinancials: true,
    subtotal: 500, total: 500, netIncome: 410, status: 'completada'
  });
  const d = (await reporte()).body.data;
  expect(d.comisiones.otras).toBe(90);
  expect(d.ingresoNeto).toBe(410);
});

test('solo administradores pueden ver la rentabilidad', async () => {
  const usuario = await h.login('user');
  expect((await reporte(rangoHoy, usuario.token)).status).toBe(403);
});

describe('gastos mensuales no capturados', () => {
  const d = s => new Date(s);
  test('detecta la renta que no se capturó en octubre', async () => {
    await Costo.create({ description: 'Renta', type: 'fijo', amount: 4000, category: 'renta', date: d('2026-09-21T00:00:00Z'), frequency: 'mensual' });
    const f = await recurrentesNoCapturados({ start: d('2026-10-01T00:00:00Z'), end: d('2026-10-31T23:59:59.999Z') }, d('2026-11-12T18:00:00Z'));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ descripcion: 'Renta', monto: 4000, mes: '2026-10' });
  });
  test('no la marca si se capturó en el mes, ni antes de su fecha', async () => {
    await Costo.create({ description: 'Renta', type: 'fijo', amount: 4000, category: 'renta', date: d('2026-09-21T00:00:00Z'), frequency: 'mensual' });
    await Costo.create({ description: 'renta ', type: 'fijo', amount: 4000, category: 'renta', date: d('2026-10-05T00:00:00Z') });
    await Costo.create({ description: 'Luz', type: 'variable', amount: 1800, category: 'servicios', date: d('2026-08-18T00:00:00Z'), frequency: 'mensual' });
    const oct = await recurrentesNoCapturados({ start: d('2026-10-01T00:00:00Z'), end: d('2026-10-31T23:59:59.999Z') }, d('2026-11-12T18:00:00Z'));
    expect(oct.map(x => x.descripcion)).toEqual(['Luz']);
    // Noviembre al día 12: la renta (día 21) y la luz (día 18) todavía no vencen
    const nov = await recurrentesNoCapturados({ start: d('2026-11-01T00:00:00Z'), end: d('2026-11-30T23:59:59.999Z') }, d('2026-11-12T18:00:00Z'));
    expect(nov).toEqual([]);
  });
});

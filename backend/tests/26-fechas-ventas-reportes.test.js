// Ventas y reportes: una venta hecha a cualquier hora debe contar en el día de Tepic en que se hizo.
const h = require('./helpers/app');
const { rangoPeriodoTepic } = require('../helpers/timezone');
const mongoose = require('mongoose');
const { Venta } = h.models;

describe('rangoPeriodoTepic', () => {
  const a = new Date('2026-11-12T00:30:00Z'); // miércoles 11/11 17:30 en Tepic
  test.each([
    ['day', '2026-11-11T00:00:00.000Z', '2026-11-11T23:59:59.999Z'],
    ['week', '2026-11-08T00:00:00.000Z', '2026-11-14T23:59:59.999Z'],
    ['month', '2026-11-01T00:00:00.000Z', '2026-11-30T23:59:59.999Z'],
    ['year', '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z']
  ])('%s a las 17:30 de Tepic', (period, ini, fin) => {
    const r = rangoPeriodoTepic({ period }, a);
    expect([r.start.toISOString(), r.end.toISOString()]).toEqual([ini, fin]);
  });
  test('rango de fechas YYYY-MM-DD cubre los días completos', () => {
    const r = rangoPeriodoTepic({ startDate: '2026-10-31', endDate: '2026-10-31' });
    expect([r.start.toISOString(), r.end.toISOString()]).toEqual(['2026-10-31T00:00:00.000Z', '2026-10-31T23:59:59.999Z']);
  });
});

describe('ventas después de las 17:00 de Tepic', () => {
  let admin, base;
  beforeEach(async () => {
    await h.resetAislado();
    admin = await h.login('admin');
    base = await h.seedBase();
  });
  afterAll(h.close);

  // Venta registrada a las 18:30 del 31/10 en Tepic (01:30 UTC del 1/11) con la convención correcta.
  const crearVenta = (date, total = 500) => Venta.create({
    items: [{ type: 'servicio', item: new mongoose.Types.ObjectId(), quantity: 1, unitPrice: total }],
    paymentMethod: 'efectivo', saleChannel: 'local', status: 'completada', date
  });

  test('la lista filtrada por día incluye la venta de las 18:30 en su día', async () => {
    await crearVenta(new Date('2026-10-31T18:30:00Z'));
    const r31 = await h.request(h.app).get('/api/ventas?date=2026-10-31').set(h.auth(admin.token));
    const r01 = await h.request(h.app).get('/api/ventas?date=2026-11-01').set(h.auth(admin.token));
    expect(r31.body.data).toHaveLength(1);
    expect(r01.body.data).toHaveLength(0);
  });

  test('el estado de resultados de octubre incluye la venta de las 18:30 del 31 (y noviembre no)', async () => {
    await crearVenta(new Date('2026-10-31T18:30:00Z'), 500);
    await crearVenta(new Date('2026-11-01T00:00:00Z'), 70); // fecha elegida 1/11 (calendario)
    const oct = await h.request(h.app).get('/api/reports/income-statement?startDate=2026-10-01&endDate=2026-10-31').set(h.auth(admin.token));
    const nov = await h.request(h.app).get('/api/reports/income-statement?startDate=2026-11-01&endDate=2026-11-30').set(h.auth(admin.token));
    expect(oct.body.data.ingresos.totalVentas).toBe(500);
    expect(nov.body.data.ingresos.totalVentas).toBe(70);
  });

  test('el estado de resultados no cuenta compras canceladas como costo', async () => {
    const p = await h.producto();
    const c = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 2, unitCost: 50, date: '2026-11-05' });
    const rango = '?startDate=2026-11-01&endDate=2026-11-30';
    expect((await h.request(h.app).get('/api/reports/income-statement' + rango).set(h.auth(admin.token))).body.data.costos.totalCompras).toBe(100);
    await h.request(h.app).delete('/api/compras/' + c.body.data._id).set(h.auth(admin.token));
    expect((await h.request(h.app).get('/api/reports/income-statement' + rango).set(h.auth(admin.token))).body.data.costos.totalCompras).toBe(0);
  });

  test('una venta nueva sin fecha toma la hora de Tepic (default del modelo)', () => {
    const antes = Date.now();
    const v = new Venta({ items: [], saleChannel: 'local' });
    expect(Math.abs(v.date.getTime() - (antes - 7 * 3600000))).toBeLessThan(5000);
  });
});

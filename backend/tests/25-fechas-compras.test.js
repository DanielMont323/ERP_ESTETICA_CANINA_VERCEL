// Fechas de compras: deben quedar en el día de Tepic (UTC-7), sin importar la hora del registro.
const h = require('./helpers/app');
const { hoyCalendarioTepic, getCurrentDateGMT7 } = require('../helpers/timezone');
const { InventoryLayer } = h.models;

describe('hoyCalendarioTepic', () => {
  test.each([
    ['00:30 en Tepic', '2026-11-11T07:30:00Z', '2026-11-11'],
    ['10:12 en Tepic (17:12 UTC)', '2026-11-11T17:12:00Z', '2026-11-11'],
    ['17:30 en Tepic (00:30 UTC del día siguiente)', '2026-11-12T00:30:00Z', '2026-11-11'],
    ['23:59 en Tepic', '2026-11-12T06:59:00Z', '2026-11-11']
  ])('%s → día de Tepic', (_, instante, esperado) => {
    const d = hoyCalendarioTepic(new Date(instante));
    expect(d.toISOString()).toBe(`${esperado}T12:00:00.000Z`);
  });

  test('documenta el defecto de getCurrentDateGMT7 (sigue en uso en ventas y reportes)', () => {
    // 10:12 en Tepic: getCurrentDateGMT7 devuelve el día siguiente.
    jest.useFakeTimers().setSystemTime(new Date('2026-11-11T17:12:00Z'));
    expect(getCurrentDateGMT7().toISOString().slice(0, 10)).toBe('2026-11-12');
    jest.useRealTimers();
  });
});

describe('POST/PUT /api/compras sin fecha', () => {
  let admin, base;
  beforeEach(async () => {
    await h.resetAislado();
    admin = await h.login('admin');
    base = await h.seedBase();
  });
  afterAll(h.close);

  test('una compra sin fecha queda con el día de hoy en Tepic; su capa y movimiento también', async () => {
    const p = await h.producto();
    const c = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 1, unitCost: 10 });
    expect(c.status).toBe(201);
    const hoy = hoyCalendarioTepic().toISOString();
    expect(new Date(c.body.data.date).toISOString()).toBe(hoy);
    const capa = await InventoryLayer.findOne({ purchase: c.body.data._id });
    expect(capa.receivedDate.toISOString()).toBe(hoy);
  });

  test('editar reenviando la misma fecha (como hace la pantalla) no la cambia', async () => {
    const p = await h.producto();
    const c = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 1, unitCost: 10 });
    const ymd = new Date(c.body.data.date).toISOString().slice(0, 10);
    const item = { ...c.body.data.items[0], product: c.body.data.items[0].product._id || c.body.data.items[0].product };
    const res = await h.request(h.app).put(`/api/compras/${c.body.data._id}`).set(h.auth(admin.token))
      .send({ date: ymd, items: [{ ...item, quantity: 2 }] });
    expect(res.status).toBe(200);
    expect(new Date(res.body.data.date).toISOString().slice(0, 10)).toBe(ymd);
  });
});

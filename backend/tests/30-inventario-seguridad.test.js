// Etapa 1 — Ediciones de stock fuera de FIFO, inicialización y permisos.
const h = require('./helpers/app');
const { InventoryLayer } = h.models;

let admin, base;
beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

async function productoFifo(qty = 10) {
  const p = await h.producto();
  const r = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: qty, unitCost: 50 });
  expect(r.status).toBe(201);
  return p;
}

describe('F12 — cambios de stock que no pasan por FIFO', () => {
  test('PATCH /api/productos/:id/stock sin token es rechazado (401)', async () => {
    const p = await productoFifo();
    const res = await h.request(h.app).patch(`/api/productos/${p._id}/stock`).send({ quantity: 99, operation: 'set' });
    expect(res.status).toBe(401);
  });

  test('PATCH /stock con admin no desincroniza stock y capas', async () => {
    const p = await productoFifo();
    await h.request(h.app).patch(`/api/productos/${p._id}/stock`).set(h.auth(admin.token)).send({ quantity: 3, operation: 'subtract' });
    const s = await h.stockYCapas(p._id);
    expect(s.stock).toBe(s.capas);
  });

  test('PUT /api/productos/:id con "stock" en el cuerpo no desincroniza stock y capas', async () => {
    const p = await productoFifo();
    await h.request(h.app).put(`/api/productos/${p._id}`).set(h.auth(admin.token)).send({ name: p.name, stock: 25 });
    const s = await h.stockYCapas(p._id);
    expect(s.stock).toBe(s.capas);
  });
});

describe('F14 — estado real de producción: fifoInitialized=true sin capas', () => {
  test('la inicialización FIFO crea la capa de un producto marcado como inicializado pero sin capas', async () => {
    const p = await h.producto({ stock: 7, cost: 30, fifoInitialized: true, fifoInitializationDate: new Date('2026-11-04') });
    const res = await h.request(h.app).post('/api/inventario/inicializar-fifo').set(h.auth(admin.token)).send({});
    expect(res.status).toBe(200);
    const capas = await InventoryLayer.find({ producto: p._id, source: 'inventario_inicial' });
    expect(capas).toHaveLength(1);
    expect(capas[0].remainingQuantity).toBe(7);
  });

  test('la inicialización es idempotente: correrla dos veces no duplica capas', async () => {
    const p = await h.producto({ stock: 4, cost: 30 });
    await h.request(h.app).post('/api/inventario/inicializar-fifo').set(h.auth(admin.token)).send({});
    await h.request(h.app).post('/api/inventario/inicializar-fifo?mode=continue').set(h.auth(admin.token)).send({});
    expect(await InventoryLayer.countDocuments({ producto: p._id, source: 'inventario_inicial' })).toBe(1);
  });
});

describe('Seguridad — permisos en operaciones sensibles', () => {
  test('S1: un usuario no admin no puede cancelar compras', async () => {
    const p = await h.producto();
    const c = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 1, unitCost: 10 });
    const user = await h.login('user');
    const res = await h.request(h.app).delete(`/api/compras/${c.body.data._id}`).set(h.auth(user.token));
    expect(res.status).toBe(403);
  });

  test.each([
    ['GET', '/api/costos'],
    ['POST', '/api/costos'],
    ['GET', '/api/reports/income-statement'],
    ['GET', '/api/clientes'],
    ['GET', '/api/ventas'],
    ['POST', '/api/servicios']
  ])('S2: %s %s sin token responde 401', async (method, url) => {
    const res = await h.request(h.app)[method.toLowerCase()](url).send({});
    expect(res.status).toBe(401);
  });
});

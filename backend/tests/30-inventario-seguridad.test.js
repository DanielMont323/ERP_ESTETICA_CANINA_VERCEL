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

test('S2: con token los endpoints antes abiertos siguen respondiendo', async () => {
  for (const url of ['/api/clientes', '/api/productos', '/api/servicios', '/api/costos', '/api/ventas']) {
    const res = await h.request(h.app).get(url).set(h.auth(admin.token));
    expect([url, res.status]).toEqual([url, 200]);
  }
});

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

describe('F12 — regresión: lo que sí debe seguir funcionando', () => {
  test('PUT de un producto FIFO sin cambiar el stock sí guarda los demás datos', async () => {
    const p = await productoFifo(4);
    const res = await h.request(h.app).put(`/api/productos/${p._id}`).set(h.auth(admin.token)).send({ name: 'Nombre editado', stock: 4 });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Nombre editado');
    expect(await h.stockYCapas(p._id)).toMatchObject({ stock: 4, capas: 4 });
  });

  test('PATCH /stock sigue funcionando para productos sin FIFO', async () => {
    const p = await h.producto({ stock: 5 });
    const res = await h.request(h.app).patch(`/api/productos/${p._id}/stock`).set(h.auth(admin.token)).send({ quantity: 2, operation: 'add' });
    expect(res.status).toBe(200);
    expect(res.body.data.stock).toBe(7);
  });

  test('PATCH /stock con usuario no admin es rechazado (403)', async () => {
    const p = await h.producto({ stock: 5 });
    const user = await h.login('user');
    const res = await h.request(h.app).patch(`/api/productos/${p._id}/stock`).set(h.auth(user.token)).send({ quantity: 2, operation: 'add' });
    expect(res.status).toBe(403);
  });
});

describe('F19 — PUT /api/ventas no puede cambiar el estado', () => {
  test('poner status "cancelada" por PUT es rechazado y no toca inventario', async () => {
    const p = await productoFifo(3);
    const v = await h.vender(admin.token, [{ type: 'producto', item: p._id.toString(), quantity: 1, unitPrice: 100 }]);
    expect(v.status).toBe(201);
    const user = await h.login('user');
    const res = await h.request(h.app).put(`/api/ventas/${v.body.data._id}`).set(h.auth(user.token)).send({ status: 'cancelada' });
    expect(res.status).toBe(409);
    const venta = await h.models.Venta.findById(v.body.data._id);
    expect(venta.status).toBe('completada');
    expect(await h.stockYCapas(p._id)).toMatchObject({ stock: 2, capas: 2 });
  });

  test('editar notas enviando el mismo status sigue funcionando', async () => {
    const p = await productoFifo(3);
    const v = await h.vender(admin.token, [{ type: 'producto', item: p._id.toString(), quantity: 1, unitPrice: 100 }]);
    const res = await h.request(h.app).put(`/api/ventas/${v.body.data._id}`).set(h.auth(admin.token)).send({ status: 'completada', notes: 'nota' });
    expect(res.status).toBe(200);
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
    ['POST', '/api/servicios'],
    ['GET', '/api/productos'],
    ['GET', '/api/mascotas'],
    ['GET', '/api/proveedores'],
    ['GET', '/api/recordatorios'],
    ['GET', '/api/supplier-products'],
    ['GET', '/api/categorias-producto'],
    ['PATCH', '/api/cuentas-por-pagar/000000000000000000000000/status']
  ])('S2: %s %s sin token responde 401', async (method, url) => {
    const res = await h.request(h.app)[method.toLowerCase()](url).send({});
    expect(res.status).toBe(401);
  });
});

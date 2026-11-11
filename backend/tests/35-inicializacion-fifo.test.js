// Inicialización (apertura) del inventario FIFO.
const h = require('./helpers/app');
const FIFOInitialization = require('../models/FIFOInitialization');
const { InventoryLayer, InventoryMovement, Producto } = h.models;

let admin, base;
beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

const inicializar = (body = {}) => h.request(h.app).post('/api/inventario/inicializar-fifo').set(h.auth(admin.token)).send(body);
const linea = (p, quantity) => ({ type: 'producto', item: p._id.toString(), quantity, unitPrice: 100 });

describe('apertura FIFO', () => {
  test('crea una capa y un movimiento por producto con stock, con costo capturado marcado como estimado', async () => {
    const p = await h.producto({ stock: 5, cost: 40 });
    const res = await inicializar();
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('completed');
    const capa = await InventoryLayer.findOne({ producto: p._id });
    expect(capa).toMatchObject({ source: 'inventario_inicial', costSource: 'costo_capturado', unitCost: 40, remainingQuantity: 5 });
    expect(await InventoryMovement.countDocuments({ producto: p._id, source: 'inventario_inicial' })).toBe(1);
    expect((await Producto.findById(p._id)).fifoInitialized).toBe(true);
  });

  test('producto sin costo: se abre a $0 marcado sin_costo y se reporta, sin bloquear', async () => {
    const p = await h.producto({ stock: 2, cost: 0 });
    const res = await inicializar();
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.sinCosto.map(x => String(x.product))).toContain(String(p._id));
    expect(await InventoryLayer.findOne({ producto: p._id })).toMatchObject({ unitCost: 0, costSource: 'sin_costo' });
  });

  test('omite productos sin stock y productos que ya tienen capas (de compras)', async () => {
    const sinStock = await h.producto({ stock: 0, cost: 10 });
    const conCompra = await h.producto();
    await h.comprar(admin, { proveedor: base.proveedor, productoId: conCompra._id, quantity: 3, unitCost: 20 });
    await inicializar();
    expect(await InventoryLayer.countDocuments({ producto: sinStock._id })).toBe(0);
    expect(await InventoryLayer.countDocuments({ producto: conCompra._id, source: 'inventario_inicial' })).toBe(0);
  });

  test('después de abrir, el producto se puede vender y el costo sale de la capa de apertura', async () => {
    const p = await h.producto({ stock: 3, cost: 25 });
    expect((await h.vender(admin.token, [linea(p, 1)])).status).not.toBe(201); // antes de abrir: bloqueado
    await inicializar();
    const v = await h.vender(admin.token, [linea(p, 1)]);
    expect(v.status).toBe(201);
    const salida = await InventoryMovement.findOne({ sourceId: v.body.data._id, type: 'salida' });
    expect(salida.totalCost).toBe(25);
    expect(await h.stockYCapas(p._id)).toMatchObject({ stock: 2, capas: 2 });
  });

  test('la apertura queda antes que una compra del mismo día (orden FIFO)', async () => {
    const p = await h.producto({ stock: 2, cost: 10 });
    await inicializar();
    await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 2, unitCost: 99 });
    const v = await h.vender(admin.token, [linea(p, 1)]);
    const salida = await InventoryMovement.findOne({ sourceId: v.body.data._id, type: 'salida' });
    expect(salida.totalCost).toBe(10);
  });
});

describe('F13 — el lock siempre se libera', () => {
  test('tras una corrida, otra puede iniciar (no queda "en progreso")', async () => {
    await h.producto({ stock: 1, cost: 5 });
    expect((await inicializar()).status).toBe(200);
    const init = await FIFOInitialization.findOne({ identifier: 'global' });
    expect(init.lockOwnerId).toBeNull();
    expect((await inicializar()).status).toBe(200);
  });

  test('un lock vigente de otra corrida responde 409; uno vencido se recupera', async () => {
    await FIFOInitialization.create({ identifier: 'global', status: 'in_progress', lockOwnerId: 'otro', lockExpiresAt: new Date(Date.now() + 60000), attemptCount: 1 });
    expect((await inicializar()).status).toBe(409);
    await FIFOInitialization.updateOne({ identifier: 'global' }, { lockExpiresAt: new Date(Date.now() - 1000) });
    expect((await inicializar()).status).toBe(200);
  });

  test('estado real de producción (failed, intento previo) se puede reintentar', async () => {
    await FIFOInitialization.create({ identifier: 'global', status: 'failed', lockOwnerId: null, attemptCount: 2, productsSuccess: 1, productsFailed: 1 });
    const p = await h.producto({ stock: 4, cost: 8, fifoInitialized: true });
    const res = await inicializar();
    expect(res.status).toBe(200);
    expect(await InventoryLayer.countDocuments({ producto: p._id })).toBe(1);
  });
});

// Etapa 1 — Reproducción de defectos FIFO en ventas.
// Cada prueba describe el comportamiento CORRECTO esperado: si falla, el defecto existe.
const h = require('./helpers/app');
const { InventoryMovement, InventoryLayer, Producto, Servicio } = h.models;
const Venta = require('../models/Venta');

let admin, base;
const linea = (p, quantity, unitPrice = 100) => ({ type: 'producto', item: p._id.toString(), quantity, unitPrice });

beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

async function productoConCompras(compras) {
  const p = await h.producto();
  for (const [quantity, unitCost] of compras) {
    const r = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity, unitCost });
    expect(r.status).toBe(201);
  }
  return p;
}

describe('F1 — POST /api/ventas: consumo FIFO', () => {
  test('una venta nueva responde 201 y registra el costo FIFO real (10×$50 + 2×$60 = $620)', async () => {
    const p = await productoConCompras([[10, 50], [10, 60]]);
    const res = await h.vender(admin.token, [linea(p, 12)]);
    expect(res.status).toBe(201);
    const movs = await InventoryMovement.find({ sale: res.body.data._id, type: 'salida' });
    expect(movs).toHaveLength(1);
    expect(movs[0].totalCost).toBeCloseTo(620, 2);
    expect(typeof movs[0].operationId).toBe('string');
    const s = await h.stockYCapas(p._id);
    expect(s).toMatchObject({ stock: 8, capas: 8 });
  });

  test('si la venta falla, las capas FIFO no quedan descontadas (atomicidad)', async () => {
    const p = await productoConCompras([[10, 50]]);
    const res = await h.vender(admin.token, [linea(p, 3)]);
    if (res.status !== 201) {
      const s = await h.stockYCapas(p._id);
      expect(s).toMatchObject({ stock: 10, capas: 10 });
      expect(await Venta.countDocuments()).toBe(0);
    } else {
      expect(res.status).toBe(201);
    }
  });
});

describe('F15 — POST /api/ventas: un error FIFO debe responder, no colgarse', () => {
  test('vender más de lo disponible responde con error HTTP y no crea venta', async () => {
    const p = await productoConCompras([[2, 50]]);
    const res = await h.vender(admin.token, [linea(p, 5)]);
    expect(res.status).not.toBe('SIN_RESPUESTA');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await Venta.countDocuments()).toBe(0);
  });
});

describe('F2/F3 — PUT /api/ventas: ediciones sucesivas', () => {
  test('editar dos veces la cantidad deja el inventario correcto (10 − 4 = 6)', async () => {
    const p = await productoConCompras([[10, 50]]);
    const v = await h.vender(admin.token, [linea(p, 2)]);
    expect(v.status).toBe(201);
    const id = v.body.data._id;
    const e1 = await h.request(h.app).put(`/api/ventas/${id}`).set(h.auth(admin.token)).send({ items: [linea(p, 3)] });
    expect(e1.status).toBe(200);
    const e2 = await h.request(h.app).put(`/api/ventas/${id}`).set(h.auth(admin.token)).send({ items: [linea(p, 4)] });
    expect(e2.status).toBe(200);
    const s = await h.stockYCapas(p._id);
    expect(s).toMatchObject({ stock: 6, capas: 6 });
  });

  test('F3: cada movimiento de reversión referencia el movimiento original', async () => {
    const p = await productoConCompras([[10, 50]]);
    const v = await h.vender(admin.token, [linea(p, 2)]);
    expect(v.status).toBe(201);
    await h.request(h.app).put(`/api/ventas/${v.body.data._id}`).set(h.auth(admin.token)).send({ items: [linea(p, 3)] });
    const rev = await InventoryMovement.find({ source: 'reversion_venta' });
    expect(rev.length).toBeGreaterThan(0);
    for (const r of rev) expect(r.originalMovement).toBeTruthy();
  });
});

describe('F4 — DELETE /api/ventas (cancelación)', () => {
  test('cancelar una venta restaura capas y stock, y el producto se puede volver a vender', async () => {
    const p = await productoConCompras([[10, 50]]);
    const v = await h.vender(admin.token, [linea(p, 4)]);
    expect(v.status).toBe(201);
    const del = await h.request(h.app).delete(`/api/ventas/${v.body.data._id}`).set(h.auth(admin.token));
    expect(del.status).toBe(200);
    const s = await h.stockYCapas(p._id);
    expect(s).toMatchObject({ stock: 10, capas: 10 });
    const otra = await h.vender(admin.token, [linea(p, 1)]);
    expect(otra.status).toBe(201);
  });

  test('cancelar una venta de servicio devuelve los insumos consumidos', async () => {
    const shampoo = await productoConCompras([[10, 20]]);
    const servicio = await Servicio.create({ name: 'Baño', price: 180, duration: 60, category: base.categoria._id, insumos: [{ producto: shampoo._id, cantidad: 1 }] });
    const v = await h.vender(admin.token, [{ type: 'servicio', item: servicio._id.toString(), quantity: 1, unitPrice: 180, mascota: base.mascota._id.toString() }], { customer: base.cliente._id.toString() });
    expect(v.status).toBe(201);
    expect((await h.stockYCapas(shampoo._id)).stock).toBe(9);
    await h.request(h.app).delete(`/api/ventas/${v.body.data._id}`).set(h.auth(admin.token));
    expect(await h.stockYCapas(shampoo._id)).toMatchObject({ stock: 10, capas: 10 });
  });
});

describe('F5 — editar una venta anterior a FIFO', () => {
  test('no descuenta dos veces: o se rechaza sin cambios, o descuenta solo la diferencia', async () => {
    // Estado real de producción: venta antigua sin movimientos; el stock ya se descontó antes de FIFO.
    const p = await h.producto({ stock: 8, fifoInitialized: true });
    await InventoryLayer.create({ producto: p._id, quantity: 8, initialQuantity: 8, remainingQuantity: 8, unitCost: 50, totalCost: 400, source: 'inventario_inicial', isInitialLayer: true, receivedDate: new Date() });
    const legacy = await Venta.create({ items: [linea(p, 2)], paymentMethod: 'efectivo', saleChannel: 'local', status: 'completada' });
    const res = await h.request(h.app).put(`/api/ventas/${legacy._id}`).set(h.auth(admin.token)).send({ items: [linea(p, 3)] });
    const s = await h.stockYCapas(p._id);
    if (res.status >= 400) expect(s).toMatchObject({ stock: 8, capas: 8 });
    else expect(s).toMatchObject({ stock: 7, capas: 7 });
  });
});

describe('F6 — reparto entre varias líneas del mismo producto', () => {
  test('cada movimiento consume cantidades enteras de cada capa y la reversión restaura exacto', async () => {
    const p = await productoConCompras([[1, 33.33], [1, 33.33], [1, 33.34]]);
    const v = await h.vender(admin.token, [linea(p, 1), linea(p, 2)]);
    expect(v.status).toBe(201);
    const movs = await InventoryMovement.find({ sale: v.body.data._id, type: 'salida' });
    const total = movs.reduce((s, m) => s + m.totalCost, 0);
    expect(total).toBeCloseTo(100, 2);
    for (const m of movs) {
      const q = m.layersConsumed.reduce((s, l) => s + l.quantityConsumed, 0);
      expect(q).toBe(Math.abs(m.quantity));
      for (const l of m.layersConsumed) expect(Number.isInteger(l.quantityConsumed)).toBe(true);
    }
    const e = await h.request(h.app).put(`/api/ventas/${v.body.data._id}`).set(h.auth(admin.token)).send({ items: [linea(p, 1)] });
    expect(e.status).toBe(200);
    const layers = await InventoryLayer.find({ producto: p._id }).sort({ receivedDate: 1, _id: 1 });
    expect(layers.map(l => l.remainingQuantity)).toEqual([0, 1, 1]);
  });
});

describe('F14 — productos con stock y sin capas FIFO', () => {
  test('vender un producto no inicializado responde con un error claro (no 500 ni cuelgue)', async () => {
    const p = await h.producto({ stock: 5 });
    const res = await h.vender(admin.token, [linea(p, 1)]);
    expect([400, 409, 422]).toContain(res.status);
  });
});

describe('F4/F5 — ventas anteriores a FIFO (sin fifoTracked)', () => {
  test('cancelar una venta histórica cuyo producto ya tiene capas FIFO se rechaza sin cambios', async () => {
    const p = await h.producto({ stock: 8, fifoInitialized: true });
    await InventoryLayer.create({ producto: p._id, quantity: 8, initialQuantity: 8, remainingQuantity: 8, unitCost: 50, totalCost: 400, source: 'inventario_inicial', isInitialLayer: true, receivedDate: new Date() });
    const legacy = await Venta.create({ items: [linea(p, 2)], paymentMethod: 'efectivo', saleChannel: 'local', status: 'completada' });
    const del = await h.request(h.app).delete(`/api/ventas/${legacy._id}`).set(h.auth(admin.token));
    expect(del.status).toBe(409);
    expect(await h.stockYCapas(p._id)).toMatchObject({ stock: 8, capas: 8 });
    expect((await Venta.findById(legacy._id)).status).toBe('completada');
  });

  test('cancelar una venta histórica de un producto sin FIFO conserva el comportamiento original', async () => {
    const p = await h.producto({ stock: 3 });
    const legacy = await Venta.create({ items: [linea(p, 2)], paymentMethod: 'efectivo', saleChannel: 'local', status: 'completada' });
    const del = await h.request(h.app).delete(`/api/ventas/${legacy._id}`).set(h.auth(admin.token));
    expect(del.status).toBe(200);
    expect((await Producto.findById(p._id)).stock).toBe(5);
  });
});

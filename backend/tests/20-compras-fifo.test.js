// Etapa 1 — Reproducción de defectos FIFO en compras.
const h = require('./helpers/app');
const { InventoryMovement, InventoryLayer } = h.models;

let admin, base;
beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

const put = (id, body) => h.request(h.app).put(`/api/compras/${id}`).set(h.auth(admin.token)).send(body);
const itemDe = c => ({ ...c.items[0], product: c.items[0].product._id || c.items[0].product });

describe('F7 — PUT /api/compras: la capa nueva conserva fecha de compra y proveedor', () => {
  test('al modificar una compra, la capa nueva mantiene receivedDate de la compra y su proveedor', async () => {
    const p = await h.producto();
    const c = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 5, unitCost: 40, date: '2026-01-15' });
    expect(c.status).toBe(201);
    const original = await InventoryLayer.findOne({ purchase: c.body.data._id });
    const res = await put(c.body.data._id, { items: [{ ...itemDe(c.body.data), quantity: 6 }] });
    expect(res.status).toBe(200);
    const nueva = await InventoryLayer.findOne({ purchase: c.body.data._id, isActive: true });
    expect(nueva.receivedDate.toISOString().slice(0, 10)).toBe(original.receivedDate.toISOString().slice(0, 10));
    expect(String(nueva.supplier)).toBe(String(base.proveedor._id));
  });
});

describe('F8 — PUT /api/compras con IVA incluido', () => {
  test('cambiar el costo con IVA incluido actualiza el costo FIFO (no usa baseUnitCost viejo)', async () => {
    const p = await h.producto();
    const c = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 2, unitCost: 116, hasTax: true, costIncludesTax: true });
    expect(c.status).toBe(201);
    expect((await InventoryLayer.findOne({ purchase: c.body.data._id })).unitCost).toBeCloseTo(116, 2);
    // El frontend reenvía el item original (con su baseUnitCost) y el costo nuevo.
    const res = await put(c.body.data._id, { items: [{ ...itemDe(c.body.data), unitCost: 232 }] });
    expect(res.status).toBe(200);
    const nueva = await InventoryLayer.findOne({ purchase: c.body.data._id, isActive: true });
    expect(nueva.unitCost).toBeCloseTo(232, 2);
  });

  test('el movimiento de reversión de la modificación vale lo mismo que la capa original', async () => {
    const p = await h.producto();
    const c = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 2, unitCost: 116, hasTax: true, costIncludesTax: true });
    await put(c.body.data._id, { items: [{ ...itemDe(c.body.data), quantity: 3 }] });
    const rev = await InventoryMovement.findOne({ source: 'modificacion_compra', sourceId: c.body.data._id });
    expect(rev.totalCost).toBeCloseTo(232, 2);
  });
});

describe('F9 — DELETE /api/compras después de una modificación', () => {
  test('genera una sola reversión por item activo (no por capas ya inactivas)', async () => {
    const p = await h.producto();
    const c = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 5, unitCost: 40 });
    expect((await put(c.body.data._id, { items: [{ ...itemDe(c.body.data), quantity: 6 }] })).status).toBe(200);
    const del = await h.request(h.app).delete(`/api/compras/${c.body.data._id}`).set(h.auth(admin.token));
    expect(del.status).toBe(200);
    const rev = await InventoryMovement.find({ source: 'cancelacion_compra', sourceId: c.body.data._id });
    expect(rev).toHaveLength(1);
    expect(rev[0].quantity).toBe(-6);
    expect(await h.stockYCapas(p._id)).toMatchObject({ stock: 0, capas: 0 });
  });
});

describe('F10 — índices y verificaciones sobre campos inexistentes', () => {
  test('InventoryLayer tiene índice sobre el campo real "purchase" (no "compra")', () => {
    const keys = InventoryLayer.schema.indexes().map(([k]) => Object.keys(k).join(','));
    expect(keys).toContain('purchase');
    expect(keys).not.toContain('compra');
  });
});

describe('F10 — consumo vigente de capas al cancelar compras', () => {
  const vender1 = p => h.vender(admin.token, [{ type: 'producto', item: p._id.toString(), quantity: 1, unitPrice: 100 }]);

  test('no se puede cancelar una compra cuya mercancía ya se vendió', async () => {
    const p = await h.producto();
    const c = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 3, unitCost: 40 });
    expect((await vender1(p)).status).toBe(201);
    const del = await h.request(h.app).delete(`/api/compras/${c.body.data._id}`).set(h.auth(admin.token));
    expect(del.status).toBe(400);
    expect(await h.stockYCapas(p._id)).toMatchObject({ stock: 2, capas: 2 });
  });

  test('sí se puede cancelar si la venta que la consumió ya fue cancelada', async () => {
    const p = await h.producto();
    const c = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 3, unitCost: 40 });
    const v = await vender1(p);
    expect((await h.request(h.app).delete(`/api/ventas/${v.body.data._id}`).set(h.auth(admin.token))).status).toBe(200);
    const del = await h.request(h.app).delete(`/api/compras/${c.body.data._id}`).set(h.auth(admin.token));
    expect(del.status).toBe(200);
    expect(await h.stockYCapas(p._id)).toMatchObject({ stock: 0, capas: 0 });
  });
});

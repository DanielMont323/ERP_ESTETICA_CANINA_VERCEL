// Etapa 1 — Índices únicos "sparse" que chocan con valores null.
// Se prueban con TODOS los índices del esquema (sin aislar).
// Nota: en producción existe idempotencyKey_1 (unique, sparse) → F16 aplica hoy.
//       movementId_1 NO existe en producción (autoIndex=false) → F17 aparecería al crear índices.
const h = require('./helpers/app');

let admin, base;
beforeEach(async () => {
  await h.resetDb();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

test('F16: dos compras seguidas sin idempotencyKey se registran ambas', async () => {
  const p = await h.producto();
  const r1 = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 1, unitCost: 10 });
  const r2 = await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 1, unitCost: 10 });
  expect(r1.status).toBe(201);
  expect(r2.status).toBe(201);
});

test('F17: se pueden guardar dos movimientos de inventario sin movementId', async () => {
  const p = await h.producto();
  const mov = () => h.models.InventoryMovement.create({ producto: p._id, type: 'entrada', quantity: 1, unitCost: 5, totalCost: 5, source: 'compra', date: new Date() });
  await mov();
  await expect(mov()).resolves.toBeTruthy();
});

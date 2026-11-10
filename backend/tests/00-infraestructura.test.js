// Verifica que la infraestructura de pruebas apunta SOLO a la base local y que el flujo básico funciona.
const h = require('./helpers/app');
const mongoose = require('mongoose');

beforeAll(h.resetDb);
afterAll(h.close);

test('la guardia fija la base erp-jest-test en 127.0.0.1:27018', () => {
  expect(process.env.MONGODB_URI).toMatch(/^mongodb:\/\/127\.0\.0\.1:27018\/erp-jest-test\?/);
  expect(mongoose.connection.name).toBe('erp-jest-test');
  expect(mongoose.connection.port).toBe(27018);
});

test('login real por /api/auth/login devuelve un JWT válido', async () => {
  const { token } = await h.login('admin');
  const res = await h.request(h.app).get('/api/compras').set(h.auth(token));
  expect(res.status).toBe(200);
});

test('una compra por HTTP crea capa FIFO y movimiento de entrada (caso base)', async () => {
  const sesion = await h.login('admin');
  const { proveedor } = await h.seedBase();
  const p = await h.producto();
  const res = await h.comprar(sesion, { proveedor, productoId: p._id, quantity: 10, unitCost: 50 });
  expect(res.status).toBe(201);
  const s = await h.stockYCapas(p._id);
  expect(s.stock).toBe(10);
  expect(s.capas).toBe(10);
  expect(s.layers[0].unitCost).toBe(50);
  const mov = await h.models.InventoryMovement.find({ producto: p._id, source: 'compra' });
  expect(mov).toHaveLength(1);
});

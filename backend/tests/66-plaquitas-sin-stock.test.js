// Productos de la categoría "Plaquita(s)" se venden aunque no haya existencias (sobre pedido).
// Si hay existencias suficientes se descuentan con FIFO como cualquier producto. Datos inventados; BD aislada de Jest.
const h = require('./helpers/app');
const CategoriaProducto = require('../models/CategoriaProducto');
const { calcularRentabilidad } = require('../helpers/rentabilidad');

let admin, base, catPlaquita;

beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
  // Como en producción: la categoría se guarda como el ID (texto) de la categoría
  catPlaquita = await CategoriaProducto.create({ name: 'Plaquita' });
});
afterAll(h.close);

const linea = (prod, quantity = 1) => ({ type: 'producto', item: String(prod._id), quantity, unitPrice: 200 });
const movimientos = (ventaId) => h.models.InventoryMovement.find({ sale: ventaId, type: 'salida' }).lean();

test('plaquita sin existencias: se vende sin tocar el inventario', async () => {
  const p = await h.producto({ name: 'Plaquita Hueso Demo', category: String(catPlaquita._id), cost: 60 });
  const r = await h.vender(admin.token, [linea(p, 2)]);
  expect(r.status).toBe(201);
  expect(await movimientos(r.body.data._id)).toHaveLength(0);
  expect(await h.stockYCapas(p._id)).toMatchObject({ stock: 0, capas: 0 });

  // Editar y cancelar la venta tampoco tocan el inventario
  const e = await h.request(h.app).put(`/api/ventas/${r.body.data._id}`).set(h.auth(admin.token))
    .send({ items: [linea(p, 3)], payments: [{ method: 'transferencia', amount: 600 }] });
  expect(e.status).toBe(200);
  const c = await h.request(h.app).delete(`/api/ventas/${r.body.data._id}`).set(h.auth(admin.token));
  expect(c.status).toBe(200);
  expect(await h.stockYCapas(p._id)).toMatchObject({ stock: 0, capas: 0 });
});

test('plaquita con existencias suficientes: se descuentan con FIFO', async () => {
  const p = await h.producto({ name: 'Plaquita Circular Demo', category: String(catPlaquita._id) });
  expect((await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 2, unitCost: 80 })).status).toBe(201);
  const r = await h.vender(admin.token, [linea(p, 1)]);
  expect(r.status).toBe(201);
  expect(await movimientos(r.body.data._id)).toHaveLength(1);
  expect(await h.stockYCapas(p._id)).toMatchObject({ stock: 1, capas: 1 });
});

test('un producto de otra categoría sin existencias sigue sin poder venderse', async () => {
  const cat = await CategoriaProducto.create({ name: 'Collares' });
  const p = await h.producto({ category: String(cat._id) });
  const r = await h.vender(admin.token, [linea(p, 1)]);
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/Stock insuficiente/);
});

test('rentabilidad: la plaquita sobre pedido usa el costo del producto sin aviso de costo aproximado', async () => {
  const p = await h.producto({ name: 'Plaquita Mini Demo', category: String(catPlaquita._id), cost: 60 });
  const r = await h.vender(admin.token, [linea(p, 2)]);
  expect(r.status).toBe(201);
  const fecha = new Date(r.body.data.date);
  const res = await calcularRentabilidad({ start: new Date(fecha.getTime() - 86400000), end: new Date(fecha.getTime() + 86400000) });
  expect(res.costoVentas.productos).toBe(120);
  expect(res.calidad.lineasSobrePedido).toBe(1);
  expect(res.calidad.notas.join(' ')).not.toMatch(/aproximado/);
});

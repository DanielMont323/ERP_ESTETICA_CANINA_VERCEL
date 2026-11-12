// Ajustes manuales de inventario (POST/GET /api/inventario/ajustes).
const h = require('./helpers/app');
const { hoyCalendarioTepic } = require('../helpers/timezone');
const { InventoryLayer, InventoryMovement, Producto } = h.models;

let admin, base;
const ajustar = (body, token = admin.token) => h.request(h.app).post('/api/inventario/ajustes').set(h.auth(token)).send(body);

beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

// Producto con dos capas: 3 piezas a $50 (más antigua) y 5 a $60
async function productoConCapas() {
  const p = await h.producto();
  await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 3, unitCost: 50 });
  await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 5, unitCost: 60 });
  return p;
}

test('una merma consume las capas más antiguas primero y registra su costo', async () => {
  const p = await productoConCapas();
  const r = await ajustar({ producto: p._id, tipo: 'salida', cantidad: 4, motivo: 'merma', notas: 'Caducados', stockEsperado: 8 });
  expect(r.status).toBe(201);
  expect(r.body.data.costo).toBe(210); // 3×50 + 1×60
  const sc = await h.stockYCapas(p._id);
  expect(sc.stock).toBe(4);
  expect(sc.capas).toBe(4);
  const mov = await InventoryMovement.findOne({ type: 'ajuste_salida' }).lean();
  expect(mov).toMatchObject({ source: 'ajuste', adjustmentReason: 'merma', quantity: -4, totalCost: 210, stockAntes: 8 });
  expect(mov.layersConsumed).toHaveLength(2);
});

test('un sobrante crea una capa con el costo de la capa más reciente', async () => {
  const p = await productoConCapas();
  const r = await ajustar({ producto: p._id, tipo: 'entrada', cantidad: 2, motivo: 'conteo_fisico', stockEsperado: 8, stockContado: 10 });
  expect(r.status).toBe(201);
  expect(r.body.data.costo).toBe(120);
  const sc = await h.stockYCapas(p._id);
  expect([sc.stock, sc.capas]).toEqual([10, 10]);
  expect(await InventoryLayer.countDocuments({ producto: p._id, source: 'ajuste_entrada' })).toBe(1);
});

test('una entrada con costo capturado usa ese costo', async () => {
  const p = await h.producto({ cost: 0 });
  const r = await ajustar({ producto: p._id, tipo: 'entrada', cantidad: 3, motivo: 'devolucion_cliente', costoUnitario: 25 });
  expect(r.status).toBe(201);
  const capa = await InventoryLayer.findOne({ producto: p._id }).lean();
  expect(capa).toMatchObject({ unitCost: 25, costSource: 'costo_capturado', remainingQuantity: 3 });
  expect((await Producto.findById(p._id)).stock).toBe(3);
});

test('rechaza sacar más de lo que hay, un motivo inválido y "otro" sin nota', async () => {
  const p = await productoConCapas();
  expect((await ajustar({ producto: p._id, tipo: 'salida', cantidad: 9, motivo: 'merma' })).status).toBe(400);
  expect((await ajustar({ producto: p._id, tipo: 'salida', cantidad: 1, motivo: 'robo' })).status).toBe(400);
  expect((await ajustar({ producto: p._id, tipo: 'salida', cantidad: 1, motivo: 'otro' })).status).toBe(400);
  expect((await ajustar({ producto: p._id, tipo: 'salida', cantidad: 1.5, motivo: 'merma' })).status).toBe(400);
  expect((await h.stockYCapas(p._id)).stock).toBe(8);
});

test('si el stock cambió desde que se cargó la pantalla, responde 409 y no ajusta', async () => {
  const p = await productoConCapas();
  const r = await ajustar({ producto: p._id, tipo: 'salida', cantidad: 1, motivo: 'merma', stockEsperado: 7 });
  expect(r.status).toBe(409);
  expect((await h.stockYCapas(p._id)).stock).toBe(8);
});

test('si stock y capas no cuadran, responde 409 y no ajusta', async () => {
  const p = await productoConCapas();
  await Producto.updateOne({ _id: p._id }, { $set: { stock: 20 } });
  expect((await ajustar({ producto: p._id, tipo: 'salida', cantidad: 1, motivo: 'merma' })).status).toBe(409);
  expect(await InventoryMovement.countDocuments({ source: 'ajuste' })).toBe(0);
});

test('solo administradores pueden ajustar o ver ajustes', async () => {
  const p = await productoConCapas();
  const usuario = await h.login('user');
  expect((await ajustar({ producto: p._id, tipo: 'salida', cantidad: 1, motivo: 'merma' }, usuario.token)).status).toBe(403);
  expect((await h.request(h.app).get('/api/inventario/ajustes').set(h.auth(usuario.token))).status).toBe(403);
});

test('el historial lista los ajustes y el reporte de ganancia resta la merma', async () => {
  const p = await productoConCapas();
  await ajustar({ producto: p._id, tipo: 'salida', cantidad: 2, motivo: 'merma', notas: 'Rotos' });
  const lista = await h.request(h.app).get('/api/inventario/ajustes').set(h.auth(admin.token));
  expect(lista.status).toBe(200);
  expect(lista.body.data).toHaveLength(1);
  expect(lista.body.data[0]).toMatchObject({ type: 'ajuste_salida', adjustmentReason: 'merma', totalCost: 100 });
  expect(lista.body.data[0].producto.name).toBe(p.name);

  const hoy = hoyCalendarioTepic().toISOString().slice(0, 10);
  const rep = await h.request(h.app).get(`/api/reports/profitability?startDate=${hoy}&endDate=${hoy}`).set(h.auth(admin.token));
  expect(rep.body.data.ajustesInventario).toMatchObject({ mermas: 100, neto: 100 });
  expect(rep.body.data.utilidadOperacion).toBe(-100);
});

test('una venta después de una merma sigue consumiendo FIFO correctamente', async () => {
  const p = await productoConCapas();
  await ajustar({ producto: p._id, tipo: 'salida', cantidad: 3, motivo: 'merma' });
  const v = await h.vender(admin.token, [{ type: 'producto', item: p._id.toString(), quantity: 2, unitPrice: 100 }]);
  expect(v.status).toBe(201);
  const salida = await InventoryMovement.findOne({ type: 'salida', sale: v.body.data._id }).lean();
  expect(salida.totalCost).toBe(120); // ya solo quedaban piezas de $60
  const sc = await h.stockYCapas(p._id);
  expect([sc.stock, sc.capas]).toEqual([3, 3]);
});

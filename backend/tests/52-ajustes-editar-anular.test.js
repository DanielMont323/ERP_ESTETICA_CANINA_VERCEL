// Editar y "eliminar" (anular) ajustes de inventario: nunca se borra un movimiento.
const h = require('./helpers/app');
const { hoyCalendarioTepic } = require('../helpers/timezone');
const { InventoryLayer, InventoryMovement } = h.models;

let admin, base;
const ajustar = (body) => h.request(h.app).post('/api/inventario/ajustes').set(h.auth(admin.token)).send(body);
const anular = (id, token = admin.token) => h.request(h.app).delete(`/api/inventario/ajustes/${id}`).set(h.auth(token));
const editar = (id, body) => h.request(h.app).put(`/api/inventario/ajustes/${id}`).set(h.auth(admin.token)).send(body);
const historial = async () => (await h.request(h.app).get('/api/inventario/ajustes').set(h.auth(admin.token))).body.data;

beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

// 3 piezas a $50 (más antigua) y 5 a $60
async function productoConCapas() {
  const p = await h.producto();
  await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 3, unitCost: 50 });
  await h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 5, unitCost: 60 });
  return p;
}
// En orden de creación (no por fecha: la capa de un ajuste lleva la hora actual y la de una compra el mediodía del día)
const capasDe = async (p) => (await InventoryLayer.find({ producto: p._id }).sort({ _id: 1 }).lean()).map(c => c.remainingQuantity);

test('anular una merma regresa las piezas a las mismas capas y no borra nada', async () => {
  const p = await productoConCapas();
  const r = await ajustar({ producto: p._id, tipo: 'salida', cantidad: 4, motivo: 'merma', notas: 'Error de captura', stockEsperado: 8 });
  expect(await capasDe(p)).toEqual([0, 4]);
  const movs = await InventoryMovement.countDocuments();

  const a = await anular(r.body.data.movimiento._id);
  expect(a.status).toBe(200);
  const sc = await h.stockYCapas(p._id);
  expect(sc.stock).toBe(8);
  expect(await capasDe(p)).toEqual([3, 5]); // mismas capas, mismo costo
  expect(await InventoryMovement.countDocuments()).toBe(movs + 1); // se agrega la anulación, no se borra
  const anulacion = await InventoryMovement.findOne({ originalMovement: r.body.data.movimiento._id }).lean();
  expect(anulacion).toMatchObject({ type: 'ajuste_entrada', quantity: 4, totalCost: 210, reversalReason: 'error_correccion', source: 'ajuste' });

  const hist = await historial();
  expect(hist).toHaveLength(1); // la anulación no aparece como ajuste aparte
  expect(hist[0].anulado).toMatchObject({ usuario: 'Usuario admin' });

  expect((await anular(r.body.data.movimiento._id)).status).toBe(409); // no se anula dos veces
  expect((await anular(anulacion._id)).status).toBe(400); // ni la anulación misma
});

test('anular una entrada saca las piezas de la capa que creó; si ya no hay stock, no deja', async () => {
  const p = await productoConCapas();
  const r = await ajustar({ producto: p._id, tipo: 'entrada', cantidad: 2, motivo: 'devolucion_cliente', costoUnitario: 70, stockEsperado: 8 });
  expect((await anular(r.body.data.movimiento._id)).status).toBe(200);
  expect((await h.stockYCapas(p._id)).stock).toBe(8);
  expect(await capasDe(p)).toEqual([3, 5, 0]);

  // Sobrante de 2 y luego se venden 9 de 10: ya no hay 2 piezas para quitar
  const r2 = await ajustar({ producto: p._id, tipo: 'entrada', cantidad: 2, motivo: 'conteo_fisico', stockEsperado: 8, stockContado: 10 });
  expect((await h.vender(admin.token, [{ type: 'producto', item: p._id.toString(), quantity: 9, unitPrice: 100 }])).status).toBe(201);
  const a = await anular(r2.body.data.movimiento._id);
  expect(a.status).toBe(409);
  expect(a.body.message).toMatch(/ya no hay 2 piezas/);
  expect((await h.stockYCapas(p._id)).stock).toBe(1); // no se movió nada
});

test('editar: corrige la cantidad en una sola operación (anula el original y registra el nuevo)', async () => {
  const p = await productoConCapas();
  const r = await ajustar({ producto: p._id, tipo: 'salida', cantidad: 4, motivo: 'merma', stockEsperado: 8 });
  // Eran 2, no 4. Sin el ajuste original el stock sería 8.
  const e = await editar(r.body.data.movimiento._id, { producto: p._id, tipo: 'salida', cantidad: 2, motivo: 'merma', notas: 'Eran 2', stockEsperado: 8 });
  expect(e.status).toBe(200);
  expect(e.body.message).toBe('Ajuste corregido: stock de 4 a 6');
  const sc = await h.stockYCapas(p._id);
  expect(sc.stock).toBe(6);
  expect(sc.capas).toBe(6);
  const hist = await historial();
  expect(hist.map(x => [x.quantity, !!x.anulado])).toEqual([[-2, false], [-4, true]]);
});

test('editar con un dato inválido no deja nada a medias', async () => {
  const p = await productoConCapas();
  const r = await ajustar({ producto: p._id, tipo: 'salida', cantidad: 4, motivo: 'merma', stockEsperado: 8 });
  const e = await editar(r.body.data.movimiento._id, { producto: p._id, tipo: 'salida', cantidad: 50, motivo: 'merma', stockEsperado: 8 });
  expect(e.status).toBe(400);
  expect((await h.stockYCapas(p._id)).stock).toBe(4);
  expect(await InventoryMovement.countDocuments({ originalMovement: r.body.data.movimiento._id })).toBe(0);
});

test('la rentabilidad ya no cuenta la merma anulada', async () => {
  const p = await productoConCapas();
  const r = await ajustar({ producto: p._id, tipo: 'salida', cantidad: 4, motivo: 'merma', stockEsperado: 8 });
  const hoy = hoyCalendarioTepic().toISOString().slice(0, 10);
  const rep = async () => (await h.request(h.app).get(`/api/reports/profitability?startDate=${hoy}&endDate=${hoy}`).set(h.auth(admin.token))).body.data.ajustesInventario;
  expect((await rep()).mermas).toBe(210);
  await anular(r.body.data.movimiento._id);
  expect(await rep()).toMatchObject({ mermas: 0, sobrantes: 0, neto: 0, registros: 0 });
});

test('solo administradores', async () => {
  const p = await productoConCapas();
  const r = await ajustar({ producto: p._id, tipo: 'salida', cantidad: 1, motivo: 'merma', stockEsperado: 8 });
  const usuario = await h.login('user');
  expect((await anular(r.body.data.movimiento._id, usuario.token)).status).toBe(403);
});

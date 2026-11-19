// Caducidad capturada en las compras: se guarda en el item, en su capa FIFO y en el producto (la más próxima).
const h = require('./helpers/app');
const { InventoryLayer, Producto } = h.models;

let admin, base;
beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

const put = (id, body) => h.request(h.app).put(`/api/compras/${id}`).set(h.auth(admin.token)).send(body);
const comprar = (p, extra) => h.comprar(admin, { proveedor: base.proveedor, productoId: p._id, quantity: 3, unitCost: 40, ...extra });
const dia = d => d && new Date(d).toISOString().slice(0, 10);

test('la caducidad de la compra queda en el item, en su lote y en el producto', async () => {
  const p = await h.producto();
  const c = await comprar(p, { expirationDate: '2027-03-31' });
  expect(c.status).toBe(201);
  expect(dia(c.body.data.items[0].expirationDate)).toBe('2027-03-31');
  const capa = await InventoryLayer.findOne({ purchase: c.body.data._id }).lean();
  expect(capa.expirationDate.toISOString()).toBe('2027-03-31T12:00:00.000Z');
  expect(dia((await Producto.findById(p._id).lean()).expirationDate)).toBe('2027-03-31');
});

test('el producto muestra la caducidad MÁS PRÓXIMA de sus lotes con piezas; sin caducidad no se toca', async () => {
  const p = await h.producto({ expirationDate: new Date('2026-12-15T12:00:00Z') });
  await comprar(p); // sin caducidad: se conserva la que ya tenía
  expect(dia((await Producto.findById(p._id).lean()).expirationDate)).toBe('2026-12-15');
  await comprar(p, { expirationDate: '2027-06-30' });
  await comprar(p, { expirationDate: '2027-02-28' });
  expect(dia((await Producto.findById(p._id).lean()).expirationDate)).toBe('2027-02-28');
});

test('al editar la compra se conserva o cambia la caducidad del lote', async () => {
  const p = await h.producto();
  const c = await comprar(p, { expirationDate: '2027-03-31' });
  const item = { ...c.body.data.items[0], product: c.body.data.items[0].product._id || c.body.data.items[0].product };
  expect((await put(c.body.data._id, { items: [{ ...item, quantity: 4 }] })).status).toBe(200);
  let capa = await InventoryLayer.findOne({ purchase: c.body.data._id, isActive: true }).lean();
  expect(dia(capa.expirationDate)).toBe('2027-03-31');
  expect((await put(c.body.data._id, { items: [{ ...item, quantity: 4, expirationDate: '2027-01-15' }] })).status).toBe(200);
  capa = await InventoryLayer.findOne({ purchase: c.body.data._id, isActive: true }).lean();
  expect(capa.expirationDate.toISOString()).toBe('2027-01-15T12:00:00.000Z');
  expect(dia((await Producto.findById(p._id).lean()).expirationDate)).toBe('2027-01-15');
});

test('una fecha de caducidad inválida se rechaza sin registrar nada', async () => {
  const p = await h.producto();
  const r = await comprar(p, { expirationDate: '31/03/2027' });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/caducidad/);
  expect((await Producto.findById(p._id).lean()).stock).toBe(0);
});

describe('precio al público editado en la compra', () => {
  test('al crear la compra actualiza el precio de venta del producto; vacío no lo cambia', async () => {
    const p = await h.producto({ price: 50 });
    expect((await comprar(p, { precioPublico: 65.5 })).status).toBe(201);
    expect((await Producto.findById(p._id).lean()).price).toBe(65.5);
    expect((await comprar(p, { precioPublico: '' })).status).toBe(201);
    expect((await Producto.findById(p._id).lean()).price).toBe(65.5);
  });

  test('al editar la compra también lo actualiza', async () => {
    const p = await h.producto({ price: 50 });
    const c = await comprar(p);
    const item = { ...c.body.data.items[0], product: c.body.data.items[0].product._id || c.body.data.items[0].product };
    expect((await put(c.body.data._id, { items: [{ ...item, precioPublico: 80 }] })).status).toBe(200);
    expect((await Producto.findById(p._id).lean()).price).toBe(80);
  });

  test('un precio inválido se rechaza sin guardar nada (al crear y al editar)', async () => {
    const p = await h.producto({ price: 50 });
    const r = await comprar(p, { precioPublico: -5 });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Precio al público/);
    expect((await Producto.findById(p._id).lean())).toMatchObject({ price: 50, stock: 0 });

    const c = await comprar(p);
    const item = { ...c.body.data.items[0], product: c.body.data.items[0].product._id || c.body.data.items[0].product };
    const e = await put(c.body.data._id, { items: [{ ...item, quantity: 9, precioPublico: 'abc' }] });
    expect(e.status).toBe(400);
    expect((await Producto.findById(p._id).lean())).toMatchObject({ price: 50, stock: 3 });
  });
});

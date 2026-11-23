// Anticipo: lo que el cliente dio antes de la venta. El total no cambia; los pagos solo cubren el resto.
// Datos inventados; BD aislada de Jest.
const h = require('./helpers/app');

let admin, base, prod;

beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
  prod = await h.producto({ name: 'Collar Demo' });
  expect((await h.comprar(admin, { proveedor: base.proveedor, productoId: prod._id, quantity: 10, unitCost: 100 })).status).toBe(201);
});
afterAll(h.close);

const linea = (quantity = 1) => ({ type: 'producto', item: String(prod._id), quantity, unitPrice: 500 });
const editar = (id, body) => h.request(h.app).put(`/api/ventas/${id}`).set(h.auth(admin.token)).send(body);

test('con anticipo, los pagos cubren solo el resto y el total no cambia', async () => {
  const r = await h.vender(admin.token, [linea(2)], {
    anticipo: { monto: 300, nota: 'Lo dio el 20/11' },
    payments: [{ method: 'transferencia', amount: 700 }]
  });
  expect(r.status).toBe(201);
  expect(r.body.data.total).toBe(1000);
  expect(r.body.data.anticipo).toEqual({ monto: 300, nota: 'Lo dio el 20/11' });
});

test('con anticipo y efectivo, el cambio se calcula sobre el resto', async () => {
  const r = await h.vender(admin.token, [linea(2)], {
    anticipo: { monto: 300 },
    payments: [{ method: 'efectivo', amount: 800 }]
  });
  expect(r.status).toBe(201);
  expect(r.body.data.change).toBe(100);
});

test('si los pagos no cubren el resto, se rechaza', async () => {
  const r = await h.vender(admin.token, [linea(2)], {
    anticipo: { monto: 300 },
    payments: [{ method: 'transferencia', amount: 600 }]
  });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/anticipo/);
});

test('un anticipo mayor que el total se rechaza; sin anticipo todo sigue igual', async () => {
  const mayor = await h.vender(admin.token, [linea(1)], { anticipo: { monto: 600 }, payments: [{ method: 'transferencia', amount: 0 }] });
  expect(mayor.status).toBe(400);
  const normal = await h.vender(admin.token, [linea(1)], { anticipo: { monto: 0 } });
  expect(normal.status).toBe(201);
  expect(normal.body.data.anticipo).toBeUndefined();
});

test('al editar se puede agregar el anticipo ajustando los pagos', async () => {
  const v = (await h.vender(admin.token, [linea(2)])).body.data;
  const r = await editar(v._id, { anticipo: { monto: 250 }, payments: [{ method: 'transferencia', amount: 750 }] });
  expect(r.status).toBe(200);
  expect(r.body.data.anticipo.monto).toBe(250);
  expect(r.body.data.total).toBe(1000);
});

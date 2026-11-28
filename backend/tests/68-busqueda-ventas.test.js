// Buscador de Ventas: busca en todas las ventas (no solo en la página cargada). Datos inventados; BD aislada de Jest.
const h = require('./helpers/app');

let admin, base, prod, ricardo, mascotaRicardo;

beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
  prod = await h.producto({ name: 'Croquetas Demo' });
  expect((await h.comprar(admin, { proveedor: base.proveedor, productoId: prod._id, quantity: 50, unitCost: 10 })).status).toBe(201);
  ricardo = await h.models.Cliente.create({ name: 'Ricardo Núñez Ficticio', phone: '3110000001' });
  mascotaRicardo = await h.models.Mascota.create({ name: 'Rayo', type: 'perro', breed: 'Mestizo', weight: 8, gender: 'macho', owner: ricardo._id });
});
afterAll(h.close);

const linea = () => ({ type: 'producto', item: String(prod._id), quantity: 1, unitPrice: 100 });
const listar = (params) => h.request(h.app).get('/api/ventas').set(h.auth(admin.token)).query({ status: 'completada', ...params });

test('encuentra la venta de Ricardo aunque esté fuera de la primera página', async () => {
  // La venta de Ricardo es la más antigua: con limit 3 quedaría en la última página
  expect((await h.vender(admin.token, [linea()], { customer: String(ricardo._id) })).status).toBe(201);
  for (let i = 0; i < 5; i++) expect((await h.vender(admin.token, [linea()])).status).toBe(201);

  const sinBuscar = await listar({ limit: 3, page: 1 });
  expect(sinBuscar.body.pagination.total).toBe(6);
  expect(sinBuscar.body.data.some(v => v.customer?.name?.startsWith('Ricardo'))).toBe(false);

  const r = await listar({ limit: 3, page: 1, search: 'ricardo' });
  expect(r.status).toBe(200);
  expect(r.body.pagination.total).toBe(1);
  expect(r.body.data[0].customer.name).toBe('Ricardo Núñez Ficticio');
});

test('sin importar acentos, y también por teléfono, mascota, producto o nota', async () => {
  await h.vender(admin.token, [linea()], { customer: String(ricardo._id), mascota: String(mascotaRicardo._id) });
  await h.vender(admin.token, [linea()], { notes: 'Pedido especial de la señora' });

  expect((await listar({ search: 'nunez' })).body.pagination.total).toBe(1);
  expect((await listar({ search: '3110000001' })).body.pagination.total).toBe(1);
  expect((await listar({ search: 'rayo' })).body.pagination.total).toBe(1);
  expect((await listar({ search: 'croquetas' })).body.pagination.total).toBe(2);
  expect((await listar({ search: 'senora' })).body.pagination.total).toBe(1);
  expect((await listar({ search: 'nadie-asi' })).body.pagination.total).toBe(0);
  // Caracteres especiales no rompen la búsqueda
  expect((await listar({ search: '(.*' })).status).toBe(200);
});

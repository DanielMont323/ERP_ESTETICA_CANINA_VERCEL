// Filtro de productos por proveedor (GET /api/productos?supplier=...). Solo lectura.
const h = require('./helpers/app');
const SupplierProduct = require('../models/SupplierProduct');
const { Proveedor } = h.models;

let admin, base;
beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

const listar = (q) => h.request(h.app).get(`/api/productos${q}`).set(h.auth(admin.token));

test('incluye proveedor principal, catálogo del proveedor y lo que se le ha comprado; excluye lo demás', async () => {
  const otro = await Proveedor.create({ name: 'Otro Proveedor', contact: 'X', phone: '3119999999', creditDays: 0 });
  const principal = await h.producto({ name: 'A principal', supplier: base.proveedor._id });
  const comprado = await h.producto({ name: 'B comprado' });
  const catalogo = await h.producto({ name: 'C catálogo' });
  const ajeno = await h.producto({ name: 'D de otro' });
  await h.producto({ name: 'E sin nada' });
  expect((await h.comprar(admin, { proveedor: base.proveedor, productoId: comprado._id, quantity: 2, unitCost: 10 })).status).toBe(201);
  expect((await h.comprar(admin, { proveedor: otro, productoId: ajeno._id, quantity: 2, unitCost: 10 })).status).toBe(201);
  await SupplierProduct.create({ supplier: base.proveedor._id, product: catalogo._id, baseCost: 5 });

  const r = await listar(`?supplier=${base.proveedor._id}`);
  expect(r.status).toBe(200);
  expect(r.body.data.map(p => p.name).sort()).toEqual(['A principal', 'B comprado', 'C catálogo']);
  expect(r.body.pagination.total).toBe(3);

  // Se combina con la búsqueda y con "bajo stock"
  expect((await listar(`?supplier=${base.proveedor._id}&search=comprado`)).body.data.map(p => p.name)).toEqual(['B comprado']);
  const otroR = await listar(`?supplier=${otro._id}`);
  expect(otroR.body.data.map(p => p.name)).toEqual(['D de otro']);
  void principal;

  // Sin filtro, salen todos
  expect((await listar('')).body.data).toHaveLength(5);
  expect((await listar('?supplier=no-valido')).status).toBe(400);
});

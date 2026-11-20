// Editar una venta con vacunas/desparasitantes: corrige la próxima dosis en el carnet de las aplicaciones
// de ESA venta o agrega las que falten. Nunca borra. Datos inventados; BD aislada de Jest.
const h = require('./helpers/app');
const CarnetVacunacion = require('../models/CarnetVacunacion');
const CategoriaProducto = require('../models/CategoriaProducto');
const Mascota = require('../models/Mascota');
const Cliente = require('../models/Cliente');

let admin, base, prod;
const DIA = 86400000;
const dia = d => new Date(d).toISOString().slice(0, 10);

beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
  // Como en producción: la categoría se guarda como el ID (texto) de la categoría
  const cat = await CategoriaProducto.create({ name: 'Desparasitante integral' });
  prod = await h.producto({ name: 'Bravecto Demo', category: String(cat._id) });
  expect((await h.comprar(admin, { proveedor: base.proveedor, productoId: prod._id, quantity: 10, unitCost: 100 })).status).toBe(201);
});
afterAll(h.close);

const linea = (extra = {}) => ({ type: 'producto', item: String(prod._id), quantity: 1, unitPrice: 300, ...extra });
const editar = (id, body) => h.request(h.app).put(`/api/ventas/${id}`).set(h.auth(admin.token)).send(body);
const aplicacionesDe = async (ventaId) => (await CarnetVacunacion.find({ 'vacunas.venta': ventaId }).lean())
  .flatMap(c => c.vacunas.filter(v => String(v.venta) === String(ventaId)).map(v => ({ ...v, mascota: String(c.mascota) })));

async function venderDesparasitante(dias = 30) {
  const r = await h.vender(admin.token, [linea({ aplicaciones: [{ mascota: String(base.mascota._id) }], diasProximaDosis: dias })], { customer: String(base.cliente._id) });
  expect(r.status).toBe(201);
  return r.body.data;
}

test('cambiar los días corrige la próxima dosis en el carnet, sin duplicar', async () => {
  const v = await venderDesparasitante(30);
  const [antes] = await aplicacionesDe(v._id);
  expect(antes.tipo).toBe('desparasitante');

  const r = await editar(v._id, { customer: String(base.cliente._id), items: [linea({ aplicaciones: [{ mascota: String(base.mascota._id) }], diasProximaDosis: 90 })] });
  expect(r.status).toBe(200);
  const despues = await aplicacionesDe(v._id);
  expect(despues).toHaveLength(1);
  expect(String(despues[0]._id)).toBe(String(antes._id));
  expect(dia(despues[0].proximaDosis)).toBe(dia(new Date(new Date(v.date).getTime() + 90 * DIA)));
  expect(despues[0].fecha.toISOString()).toBe(antes.fecha.toISOString()); // la fecha de aplicación no cambia
});

test('sin días capturados la próxima dosis del carnet no cambia', async () => {
  const v = await venderDesparasitante(30);
  const [antes] = await aplicacionesDe(v._id);
  expect((await editar(v._id, { customer: String(base.cliente._id), items: [linea({ aplicaciones: [{ mascota: String(base.mascota._id) }], diasProximaDosis: '' })] })).status).toBe(200);
  const [despues] = await aplicacionesDe(v._id);
  expect(despues.proximaDosis.toISOString()).toBe(antes.proximaDosis.toISOString());
});

test('una pieza más para otra mascota se agrega al carnet; al quitarla no se borra nada', async () => {
  const v = await venderDesparasitante(30);
  const otra = await Mascota.create({ name: 'Luna', type: 'perro', breed: 'Mestizo', weight: 5, gender: 'hembra', owner: base.cliente._id });
  const dos = [{ mascota: String(base.mascota._id) }, { mascota: String(otra._id) }];
  expect((await editar(v._id, { customer: String(base.cliente._id), items: [linea({ quantity: 2, aplicaciones: dos, diasProximaDosis: 30 })] })).status).toBe(200);
  let aps = await aplicacionesDe(v._id);
  expect(aps).toHaveLength(2);
  expect(aps.map(a => a.mascota).sort()).toEqual([String(base.mascota._id), String(otra._id)].sort());

  expect((await editar(v._id, { customer: String(base.cliente._id), items: [linea({ aplicaciones: [{ mascota: String(base.mascota._id) }], diasProximaDosis: 30 })] })).status).toBe(200);
  aps = await aplicacionesDe(v._id);
  expect(aps).toHaveLength(2); // nunca se borra
});

test('venta capturada a la antigua (mascota en el producto, sin días): al editar se le pone próxima dosis', async () => {
  const r = await h.vender(admin.token, [linea({ mascota: String(base.mascota._id) })], { customer: String(base.cliente._id) });
  expect(r.status).toBe(201);
  const antes = await aplicacionesDe(r.body.data._id);
  expect((await editar(r.body.data._id, { customer: String(base.cliente._id), items: [linea({ aplicaciones: [{ mascota: String(base.mascota._id) }], diasProximaDosis: 15 })] })).status).toBe(200);
  const despues = await aplicacionesDe(r.body.data._id);
  expect(despues).toHaveLength(Math.max(antes.length, 1));
  expect(despues.every(a => dia(a.proximaDosis) === dia(new Date(new Date(r.body.data.date).getTime() + 15 * DIA)))).toBe(true);
});

test('una mascota de otro cliente se rechaza y no se cambia nada', async () => {
  const v = await venderDesparasitante(30);
  const [antes] = await aplicacionesDe(v._id);
  const ajeno = await Cliente.create({ name: 'Otro Cliente', phone: '3119999999' });
  const ajena = await Mascota.create({ name: 'Ajena', type: 'gato', breed: 'Mestizo', weight: 3, gender: 'hembra', owner: ajeno._id });
  const r = await editar(v._id, { customer: String(base.cliente._id), items: [linea({ aplicaciones: [{ mascota: String(ajena._id) }], diasProximaDosis: 90 })] });
  expect(r.status).toBe(403);
  const despues = await aplicacionesDe(v._id);
  expect(despues).toHaveLength(1);
  expect(despues[0].proximaDosis.toISOString()).toBe(antes.proximaDosis.toISOString());
});

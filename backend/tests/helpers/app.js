// Utilidades de prueba: arranque de la app real, base limpia, datos semilla y login JWT real.
const mongoose = require('mongoose');
const request = require('supertest');

// Silenciar el ruido de console.log de la app (los errores se conservan).
jest.spyOn(console, 'log').mockImplementation(() => {});

const app = require('../../server'); // llama a connectDB() con la URI ya validada

const Usuario = require('../../models/Usuario');
const Proveedor = require('../../models/Proveedor');
const Producto = require('../../models/Producto');
const Servicio = require('../../models/Servicio');
const CategoriaServicio = require('../../models/CategoriaServicio');
const Cliente = require('../../models/Cliente');
const Mascota = require('../../models/Mascota');
const InventoryLayer = require('../../models/InventoryLayer');
const InventoryMovement = require('../../models/InventoryMovement');

async function connected() {
  if (mongoose.connection.readyState !== 1) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once('open', resolve);
      mongoose.connection.once('error', reject);
    });
  }
  const { host, port, name } = mongoose.connection;
  if (host !== '127.0.0.1' || Number(port) !== 27018 || name !== 'erp-jest-test') {
    throw new Error(`[GUARDIA] Conectado a ${host}:${port}/${name}; se esperaba 127.0.0.1:27018/erp-jest-test`);
  }
}

// Borra SOLO la base erp-jest-test (verificada arriba) y recrea índices de los modelos.
// aislarF16F17: quita los índices únicos que chocan con valores null (defectos F16 y F17)
// para poder medir los demás defectos por separado.
async function resetDb({ aislarF16F17 = false } = {}) {
  await connected();
  await mongoose.connection.db.dropDatabase();
  for (const m of Object.values(mongoose.models)) await m.createCollection().catch(() => {});
  await Promise.all(Object.values(mongoose.models).map(m => m.syncIndexes()));
  if (aislarF16F17) {
    await mongoose.connection.db.collection('compras').dropIndex('idempotencyKey_1').catch(() => {});
    await mongoose.connection.db.collection('inventorymovements').dropIndex('movementId_1').catch(() => {});
  }
}
const resetAislado = () => resetDb({ aislarF16F17: true });

async function login(role = 'admin') {
  const email = `${role}.${Date.now()}${Math.floor(Math.random() * 1e6)}@prueba.mx`;
  const password = 'Prueba-12345';
  const u = await Usuario.create({ name: `Usuario ${role}`, email, password, role });
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200 || !res.body.token) throw new Error(`Login falló: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, userId: u._id };
}

const auth = token => ({ Authorization: `Bearer ${token}` });

async function seedBase() {
  const proveedor = await Proveedor.create({ name: 'Proveedor Prueba', contact: 'Contacto', phone: '3110000000', creditDays: 30 });
  const cliente = await Cliente.create({ name: 'Cliente Prueba', phone: '3111111111' });
  const mascota = await Mascota.create({ name: 'Firulais', type: 'perro', breed: 'Mestizo', weight: 10, gender: 'macho', owner: cliente._id });
  const categoria = await CategoriaServicio.create({ name: 'Estética' });
  return { proveedor, cliente, mascota, categoria };
}

let skuSeq = 0;
async function producto(overrides = {}) {
  skuSeq += 1;
  return Producto.create({ name: `Producto ${skuSeq}`, sku: `JEST-${Date.now()}-${skuSeq}`, cost: 10, price: 50, stock: 0, category: 'General', ...overrides });
}

// Registra una compra de contado por la API real (crea capa FIFO).
async function comprar({ token, userId }, { proveedor, productoId, quantity, unitCost, date, ...extra }) {
  const res = await request(app).post('/api/compras').set(auth(token)).send({
    proveedor: proveedor._id, type: 'contado', paymentMethod: 'efectivo', user: userId,
    items: [{ product: productoId, quantity, unitCost, hasTax: false, taxRate: 0.16, costIncludesTax: false, ...extra }],
    ...(date && { date })
  });
  return res;
}

async function vender(token, items, extra = {}) {
  const total = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  // Si el servidor no responde en 10 s (defecto F15) se devuelve status 'SIN_RESPUESTA' en vez de colgar la prueba.
  return request(app).post('/api/ventas').set(auth(token)).send({
    items, payments: [{ method: 'transferencia', amount: total }], saleChannel: 'local', ...extra
  }).timeout({ response: 10000 }).catch(e => (e.timeout ? { status: 'SIN_RESPUESTA', body: {} } : Promise.reject(e)));
}

async function stockYCapas(productoId) {
  const p = await Producto.findById(productoId).lean();
  const capas = await InventoryLayer.find({ producto: productoId, isActive: true }).lean();
  return { stock: p.stock, capas: capas.reduce((s, c) => s + c.remainingQuantity, 0), layers: capas };
}

async function close() {
  await mongoose.disconnect();
}

module.exports = {
  app, request, auth, resetDb, resetAislado, login, seedBase, producto, comprar, vender, stockYCapas, close,
  models: { Usuario, Proveedor, Producto, Servicio, CategoriaServicio, Cliente, Mascota, InventoryLayer, InventoryMovement }
};

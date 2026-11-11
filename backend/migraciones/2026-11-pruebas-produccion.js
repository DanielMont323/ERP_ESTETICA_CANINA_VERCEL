/**
 * Pruebas del código nuevo sobre la BD de PRODUCCIÓN (autorizadas por el usuario el 2026-11-11).
 *
 * Levanta la app nueva en memoria conectada a producción y ejerce compras, ventas y productos
 * con un producto de prueba aislado ("ZZ PRUEBA SISTEMA"), proveedor de prueba ya inactivo y
 * compras de contado (no tocan deudas de proveedores reales).
 *
 * NO ejecuta la apertura FIFO ni la corrección de fechas (deben ir con el despliegue).
 * NO toca ventas, compras ni productos reales.
 * Al final: venta y compra quedan canceladas, el producto inactivo y el usuario de prueba sin
 * contraseña utilizable (rol user). Los _id creados quedan en respaldos-migracion/pruebas-produccion-*.json.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const prodEnv = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
if (!/cluster0\.xi0cc\.mongodb\.net\/estetica-canica/.test(prodEnv.MONGODB_URI)) throw new Error('URI inesperada');
process.env.MONGODB_URI = prodEnv.MONGODB_URI;
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex'); // secreto local: los tokens solo sirven aquí
process.env.NODE_ENV = 'production'; // sin autoIndex/autoCreate

const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const Usuario = require('../models/Usuario');
const Producto = require('../models/Producto');
const Proveedor = require('../models/Proveedor');
const Compra = require('../models/Compra');
const Venta = require('../models/Venta');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const { hoyCalendarioTepic } = require('../helpers/timezone');

const H = 3600000;
const resultados = [];
const creados = { usuario: null, producto: null, compra: null, venta: null };
const check = (nombre, ok, detalle = '') => { resultados.push({ nombre, ok: !!ok, detalle }); console.log(`${ok ? 'OK  ' : 'FALLA'} ${nombre}${detalle ? ' — ' + detalle : ''}`); };
const estado = async id => {
  const p = await Producto.findById(id).lean();
  const capas = await InventoryLayer.find({ producto: id, isActive: true }).lean();
  return { stock: p.stock, capas: capas.reduce((s, c) => s + c.remainingQuantity, 0), layers: capas };
};

(async () => {
  await new Promise(r => (mongoose.connection.readyState === 1 ? r() : mongoose.connection.once('open', r)));
  if (mongoose.connection.name !== 'estetica-canica') throw new Error('Base inesperada: ' + mongoose.connection.name);
  console.log(`Conectado a producción: ${mongoose.connection.name}\n`);

  // Usuario de prueba: contraseña aleatoria descartada; el token se firma localmente.
  const usuario = await Usuario.create({ name: 'ZZ Prueba Sistema', email: `zz-prueba-sistema-${Date.now()}@prueba.mx`, password: crypto.randomBytes(24).toString('hex'), role: 'admin' });
  creados.usuario = usuario._id;
  const auth = { Authorization: 'Bearer ' + jwt.sign({ id: usuario._id }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
  const api = () => request(app);

  const proveedor = await Proveedor.findOne({ name: 'Proveedor Test FIFO' });
  const deudaAntes = proveedor.currentDebt;

  // Producto de prueba
  let r = await api().post('/api/productos').set(auth).send({
    name: 'ZZ PRUEBA SISTEMA FIFO - NO VENDER', sku: `ZZ-PRUEBA-SISTEMA-${Date.now()}`, cost: 100, price: 200, stock: 0, minStock: 0, category: 'Shampoo'
  });
  check('Crear producto de prueba', r.status === 201, `status ${r.status} ${r.body.message || ''}`);
  const pid = r.body.data._id; creados.producto = pid;

  // ---- Compras
  r = await api().post('/api/compras').set(auth).send({
    proveedor: proveedor._id, type: 'contado', paymentMethod: 'efectivo', user: usuario._id, notes: 'PRUEBA SISTEMA - no es compra real',
    items: [{ product: pid, quantity: 2, unitCost: 116, hasTax: true, taxRate: 0.16, costIncludesTax: true }]
  });
  check('Compra 2 × $116 IVA incluido', r.status === 201, `status ${r.status} ${r.body.message || ''}`);
  const compra = r.body.data; creados.compra = compra._id;
  let s = await estado(pid);
  check('Stock 2 y capa de 2', s.stock === 2 && s.capas === 2, JSON.stringify({ stock: s.stock, capas: s.capas }));
  check('Capa a $116 con origen "compra" y proveedor', s.layers[0].unitCost === 116 && s.layers[0].costSource === 'compra' && String(s.layers[0].supplier) === String(proveedor._id), `unitCost ${s.layers[0].unitCost}, ${s.layers[0].costSource}`);
  check('Fecha de la compra = hoy en Tepic', new Date(compra.date).toISOString() === hoyCalendarioTepic().toISOString(), new Date(compra.date).toISOString());

  const item = { ...compra.items[0], product: pid };
  r = await api().put(`/api/compras/${compra._id}`).set(auth).send({ date: new Date(compra.date).toISOString().slice(0, 10), items: [{ ...item, quantity: 3 }] });
  check('Editar compra a 3 piezas', r.status === 200, `status ${r.status} ${r.body.message || ''}`);
  s = await estado(pid);
  const rev = await InventoryMovement.findOne({ source: 'modificacion_compra', sourceId: compra._id });
  check('Stock 3, reversión de $232, capa nueva 3 × $116', s.stock === 3 && s.capas === 3 && rev && Math.abs(rev.totalCost - 232) < 0.01 && s.layers[0].unitCost === 116, JSON.stringify({ stock: s.stock, reversion: rev && rev.totalCost }));
  check('La edición conserva la fecha de compra', new Date(r.body.data.date).toISOString() === new Date(compra.date).toISOString());
  check('Deuda del proveedor sin cambios (contado)', (await Proveedor.findById(proveedor._id)).currentDebt === deudaAntes);

  // ---- Productos (stock fuera de FIFO)
  r = await api().put(`/api/productos/${pid}`).set(auth).send({ name: 'ZZ PRUEBA SISTEMA FIFO - NO VENDER', stock: 10 });
  check('Editar stock de producto FIFO → rechazado', r.status === 409, `status ${r.status}`);
  r = await api().put(`/api/productos/${pid}`).set(auth).send({ name: 'ZZ PRUEBA SISTEMA FIFO - NO VENDER', price: 210, stock: 3 });
  check('Editar precio sin cambiar stock → guardado', r.status === 200 && r.body.data.price === 210, `status ${r.status}`);
  r = await api().patch(`/api/productos/${pid}/stock`).set(auth).send({ quantity: 5, operation: 'add' });
  check('PATCH de stock en producto FIFO → rechazado', r.status === 409, `status ${r.status}`);
  r = await api().patch(`/api/productos/${pid}/stock`).send({ quantity: 5, operation: 'add' });
  check('PATCH de stock sin sesión → 401', r.status === 401, `status ${r.status}`);

  // ---- Ventas
  const antes = Date.now();
  r = await api().post('/api/ventas').set(auth).send({ items: [{ type: 'producto', item: pid, quantity: 1, unitPrice: 210 }], payments: [{ method: 'efectivo', amount: 210 }], saleChannel: 'local', notes: 'PRUEBA SISTEMA - no es venta real' });
  check('Venta de 1 pieza', r.status === 201, `status ${r.status} ${r.body.message || ''}`);
  const venta = r.body.data; creados.venta = venta._id;
  s = await estado(pid);
  const salida = await InventoryMovement.findOne({ sourceId: venta._id, type: 'salida' });
  check('Stock 2; costo de venta $116 desde la capa', s.stock === 2 && s.capas === 2 && salida && salida.totalCost === 116, JSON.stringify({ stock: s.stock, costo: salida && salida.totalCost }));
  const v = await Venta.findById(venta._id);
  check('Venta con fifoTracked y hora de Tepic', v.fifoTracked === true && Math.abs(v.date.getTime() - (antes - 7 * H)) < 60000, v.date.toISOString());

  r = await api().delete(`/api/compras/${compra._id}`).set(auth);
  check('Cancelar compra con mercancía vendida → bloqueado', r.status === 400, `status ${r.status}`);

  r = await api().put(`/api/ventas/${venta._id}`).set(auth).send({ items: [{ type: 'producto', item: pid, quantity: 2, unitPrice: 210 }], payments: [{ method: 'efectivo', amount: 420 }] });
  check('Editar venta a 2 piezas', r.status === 200, `status ${r.status} ${r.body.message || ''}`);
  s = await estado(pid);
  check('Stock 1 tras editar', s.stock === 1 && s.capas === 1, JSON.stringify({ stock: s.stock, capas: s.capas }));

  r = await api().put(`/api/ventas/${venta._id}`).set(auth).send({ status: 'cancelada' });
  check('Cancelar por edición (status) → rechazado', r.status === 409, `status ${r.status}`);

  const hoy = new Date(Date.now() - 7 * H).toISOString().slice(0, 10);
  r = await api().get(`/api/ventas?date=${hoy}&status=completada&limit=500`).set(auth);
  check('La venta aparece en el filtro del día de hoy', r.status === 200 && r.body.data.some(x => x._id === String(venta._id)), `día ${hoy}`);

  r = await api().delete(`/api/ventas/${venta._id}`).set(auth);
  check('Cancelar la venta', r.status === 200, `status ${r.status}`);
  s = await estado(pid);
  check('Stock regresa a 3', s.stock === 3 && s.capas === 3, JSON.stringify({ stock: s.stock, capas: s.capas }));

  r = await api().delete(`/api/compras/${compra._id}`).set(auth);
  check('Cancelar la compra (ya sin ventas vigentes)', r.status === 200, `status ${r.status} ${r.body.message || ''}`);
  s = await estado(pid);
  const cancel = await InventoryMovement.find({ source: 'cancelacion_compra', sourceId: compra._id });
  check('Stock 0, una sola reversión de 3', s.stock === 0 && s.capas === 0 && cancel.length === 1 && cancel[0].quantity === -3, JSON.stringify({ stock: s.stock, reversiones: cancel.length }));

  // ---- Seguridad y lecturas
  r = await api().get('/api/clientes');
  check('Clientes sin sesión → 401', r.status === 401, `status ${r.status}`);
  r = await api().get('/api/reports/income-statement?startDate=2026-10-01&endDate=2026-10-31').set(auth);
  check('Estado de resultados de octubre responde', r.status === 200, `ventas $${r.body.data && r.body.data.ingresos.totalVentas}`);
  r = await api().get('/api/inventario/estado-fifo').set(auth);
  check('Estado FIFO sin cambios (no se abrió inventario)', r.status === 200 && r.body.data.status === 'failed', r.body.data && r.body.data.status);

  // ---- Limpieza (sin borrar): producto inactivo, usuario sin acceso
  await Producto.updateOne({ _id: pid }, { $set: { isActive: false } });
  await Usuario.updateOne({ _id: usuario._id }, { $set: { role: 'user', password: crypto.randomBytes(32).toString('hex') } });
  check('Producto de prueba desactivado', (await Producto.findById(pid)).isActive === false);
  check('Capas/movimientos solo del producto de prueba', (await InventoryLayer.countDocuments({ producto: { $ne: new mongoose.Types.ObjectId(pid) } })) === 0);

  const dir = path.join(__dirname, 'respaldos-migracion');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, `pruebas-produccion-${Date.now()}.json`);
  fs.writeFileSync(log, JSON.stringify({ fecha: new Date(), creados, resultados }, null, 2));
  const fallas = resultados.filter(x => !x.ok).length;
  console.log(`\n${resultados.length - fallas}/${resultados.length} pruebas OK. Registro: ${log}`);
  await mongoose.disconnect();
  process.exit(fallas ? 1 : 0);
})().catch(async e => { console.error('ERROR', e.message, JSON.stringify(creados)); await mongoose.disconnect(); process.exit(1); });

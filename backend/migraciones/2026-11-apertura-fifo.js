/**
 * Ejecuta la APERTURA FIFO (POST /api/inventario/inicializar-fifo) con el código desplegado en este
 * repositorio, a nombre de un administrador real, y después verifica la consistencia stock vs. capas.
 * Es la misma ruta que usaría la app; se corre en proceso para no depender del token del navegador.
 *
 * Uso:
 *   node migraciones/2026-11-apertura-fifo.js --uri "<uri>" --admin <correo del admin>            (solo muestra qué haría)
 *   node migraciones/2026-11-apertura-fifo.js --uri "<uri>" --admin <correo> --aplicar [--autorizado-por-el-usuario]
 * La apertura es idempotente: si se corta, se vuelve a correr y continúa.
 */
const crypto = require('crypto');
const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const uri = arg('--uri');
const email = arg('--admin');
const aplicar = args.includes('--aplicar');
if (!uri || !email) throw new Error('Faltan --uri y/o --admin');
if (aplicar && !/^mongodb:\/\/127\.0\.0\.1:27018\//.test(uri) && !args.includes('--autorizado-por-el-usuario')) {
  throw new Error('Para escribir fuera de la copia local se requiere --autorizado-por-el-usuario.');
}
process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'production';

const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const Usuario = require('../models/Usuario');
const Producto = require('../models/Producto');
const InventoryLayer = require('../models/InventoryLayer');

(async () => {
  await new Promise(r => (mongoose.connection.readyState === 1 ? r() : mongoose.connection.once('open', r)));
  const admin = await Usuario.findOne({ email, role: 'admin' });
  if (!admin) throw new Error(`No existe un admin con correo ${email}`);
  const auth = { Authorization: 'Bearer ' + jwt.sign({ id: admin._id }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
  console.log(`Base: ${mongoose.connection.name} — admin: ${admin.name} — modo: ${aplicar ? 'APLICAR' : 'vista previa'}`);

  const filtro = { isActive: { $ne: false }, isDeleted: { $ne: true }, stock: { $gt: 0 } };
  const candidatos = await Producto.find(filtro).select('_id cost stock').lean();
  const conCapas = new Set((await InventoryLayer.distinct('producto', { isActive: true })).map(String));
  const abrir = candidatos.filter(p => !conCapas.has(String(p._id)));
  console.log(`Productos a abrir: ${abrir.length}; sin costo: ${abrir.filter(p => !(p.cost > 0)).length}; valor estimado: $${abrir.reduce((s, p) => s + (p.cost > 0 ? p.cost * p.stock : 0), 0).toFixed(2)}`);

  if (aplicar) {
    const t0 = Date.now();
    const r = await request(app).post('/api/inventario/inicializar-fifo').set(auth).send({});
    console.log(`Apertura: HTTP ${r.status} en ${((Date.now() - t0) / 1000).toFixed(1)} s →`, JSON.stringify({ status: r.body.data && r.body.data.status, abiertos: r.body.data && r.body.data.productsSuccess, omitidos: r.body.data && r.body.data.productsSkipped, fallidos: r.body.data && r.body.data.productsFailed, sinCosto: r.body.data && r.body.data.sinCosto.map(x => x.productName), errores: r.body.data && r.body.data.errors }));
  }
  const c = await request(app).get('/api/inventario/verificar-consistencia').set(auth);
  console.log(`Consistencia stock vs. capas: ${c.body.data.productosAnalizados} productos, ${c.body.data.inconsistencias.length} inconsistencias`);
  if (c.body.data.inconsistencias.length) console.log(JSON.stringify(c.body.data.inconsistencias.slice(0, 10), null, 1));
  await mongoose.disconnect();
  process.exit(0);
})().catch(async e => { console.error('ERROR', e.message); await mongoose.disconnect(); process.exit(1); });

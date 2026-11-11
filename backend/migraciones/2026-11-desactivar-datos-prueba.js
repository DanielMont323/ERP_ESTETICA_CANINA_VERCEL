/**
 * Desactiva (isActive:false) los productos y proveedores de prueba que quedaron en producción
 * por pruebas anteriores (creados 4–9/nov/2026). NO borra nada y NO toca su stock.
 * Así no entran a la apertura FIFO ni aparecen en las pantallas.
 *
 * Condiciones de seguridad (si alguna falla, no escribe nada):
 *  - Productos: SKU que empieza con TEST-, CORR-TEST o FINAL-TEST.
 *  - Proveedores: nombre exacto "Proveedor Test FIFO" o "Proveedor Test Idempotencia".
 *  - Ninguno puede tener ventas, compras ni capas/movimientos FIFO.
 *
 * Uso: node migraciones/2026-11-desactivar-datos-prueba.js --uri "<uri>" [--aplicar] [--autorizado-por-el-usuario]
 * Para revertir: el log JSON guarda los _id; basta poner isActive:true en ellos.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const uri = arg('--uri');
const aplicar = args.includes('--aplicar');
if (!uri) throw new Error('Falta --uri');
if (aplicar && !/^mongodb:\/\/127\.0\.0\.1:27018\//.test(uri) && !args.includes('--autorizado-por-el-usuario')) {
  throw new Error('Para escribir fuera de la copia local se requiere --autorizado-por-el-usuario.');
}

(async () => {
  await mongoose.connect(uri, arg('--db') ? { dbName: arg('--db') } : {});
  const db = mongoose.connection.db;
  console.log(`Base: ${db.databaseName} — modo: ${aplicar ? 'APLICAR' : 'simulación'}`);

  const productos = await db.collection('productos').find({ sku: /^(TEST-|CORR-TEST|FINAL-TEST)/ }).toArray();
  const proveedores = await db.collection('proveedors').find({ name: { $in: ['Proveedor Test FIFO', 'Proveedor Test Idempotencia'] } }).toArray();

  const bloqueos = [];
  for (const p of productos) {
    const usos = {
      ventas: await db.collection('ventas').countDocuments({ 'items.item': p._id }),
      compras: await db.collection('compras').countDocuments({ 'items.product': p._id }),
      capas: await db.collection('inventorylayers').countDocuments({ producto: p._id }),
      movimientos: await db.collection('inventorymovements').countDocuments({ producto: p._id })
    };
    if (Object.values(usos).some(n => n > 0)) bloqueos.push({ sku: p.sku, ...usos });
    console.log(`  producto ${p.sku.padEnd(22)} stock=${p.stock} activo=${p.isActive !== false}`);
  }
  for (const pr of proveedores) {
    const compras = await db.collection('compras').countDocuments({ proveedor: pr._id });
    if (compras > 0) bloqueos.push({ proveedor: pr.name, compras });
    console.log(`  proveedor ${pr.name} activo=${pr.isActive !== false}`);
  }
  console.log(`Productos: ${productos.length}, proveedores: ${proveedores.length}`);
  if (bloqueos.length) { console.error('NO se aplica: hay registros con uso real', bloqueos); process.exit(1); }
  if (!aplicar) { console.log('Simulación: no se escribió nada.'); await mongoose.disconnect(); return; }

  const dir = path.join(__dirname, 'respaldos-migracion');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, `desactivar-prueba-${db.databaseName}-${Date.now()}.json`);
  fs.writeFileSync(log, JSON.stringify({
    fecha: new Date(),
    productos: productos.map(p => ({ _id: String(p._id), sku: p.sku, name: p.name, isActiveAntes: p.isActive })),
    proveedores: proveedores.map(p => ({ _id: String(p._id), name: p.name, isActiveAntes: p.isActive }))
  }, null, 2));

  const r1 = await db.collection('productos').updateMany({ _id: { $in: productos.map(p => p._id) } }, { $set: { isActive: false } });
  const r2 = await db.collection('proveedors').updateMany({ _id: { $in: proveedores.map(p => p._id) } }, { $set: { isActive: false } });
  console.log(`Aplicado: productos ${r1.modifiedCount}, proveedores ${r2.modifiedCount}. Log: ${log}`);
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });

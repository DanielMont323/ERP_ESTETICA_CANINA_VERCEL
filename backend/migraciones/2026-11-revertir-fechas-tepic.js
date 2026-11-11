/**
 * REVIERTE la corrección de fechas usando el respaldo EJSON que dejó 2026-11-corregir-fechas-tepic.js.
 * Solo para un rollback (volver al código anterior). Restaura el valor "antes" de cada registro,
 * únicamente si el registro todavía tiene el valor "después" (no pisa cambios posteriores).
 *
 * Uso: node migraciones/2026-11-revertir-fechas-tepic.js --uri "<uri>" --respaldo <archivo.json> [--aplicar] [--autorizado-por-el-usuario]
 */
const fs = require('fs');
const mongoose = require('mongoose');
const { EJSON } = require('bson');

const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const uri = arg('--uri');
const archivo = arg('--respaldo');
const aplicar = args.includes('--aplicar');
if (!uri || !archivo) throw new Error('Faltan --uri y/o --respaldo');
if (aplicar && !/^mongodb:\/\/127\.0\.0\.1:27018\//.test(uri) && !args.includes('--autorizado-por-el-usuario')) {
  throw new Error('Para escribir fuera de la copia local se requiere --autorizado-por-el-usuario.');
}

(async () => {
  const r = EJSON.parse(fs.readFileSync(archivo, 'utf8'), { relaxed: false });
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (db.databaseName !== r.base) throw new Error(`El respaldo es de "${r.base}" y la conexión es a "${db.databaseName}"`);
  console.log(`Base: ${db.databaseName} — modo: ${aplicar ? 'APLICAR' : 'simulación'} — ventas ${r.cambiosVentas.length}, historial ${r.cambiosHistorial.length}`);
  let v = 0, h = 0;
  for (const c of r.cambiosVentas) {
    if (!aplicar) { v += await db.collection('ventas').countDocuments({ _id: c._id, date: c.despues }); continue; }
    v += (await db.collection('ventas').updateOne({ _id: c._id, date: c.despues }, { $set: { date: c.antes } })).modifiedCount;
  }
  for (const c of r.cambiosHistorial) {
    if (!aplicar) { h += await db.collection('mascotas').countDocuments({ _id: c.mascota, medicalHistory: { $elemMatch: { _id: c.entrada, date: c.despues } } }); continue; }
    h += (await db.collection('mascotas').updateOne({ _id: c.mascota }, { $set: { 'medicalHistory.$[e].date': c.antes } }, { arrayFilters: [{ 'e._id': c.entrada, 'e.date': c.despues }] })).modifiedCount;
  }
  console.log(`${aplicar ? 'Revertidos' : 'Se revertirían'}: ventas ${v}, historial ${h}`);
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });

/**
 * Corrige fechas guardadas con el defecto de getCurrentDateGMT7 (sumaba 7 h en vez de restarlas).
 *
 * Convención correcta (helpers/timezone.js): hora de Tepic en los componentes UTC
 * = instante real − 7 h. El defecto guardó instante real + 7 h (14 h de más).
 *
 * Solo corrige registros con la FIRMA EXACTA del defecto, comparando la fecha con el
 * momento de creación (timestamp del ObjectId, precisión de 1 s):
 *   - ventas.date                    fecha − creación = +7 h (±2 s)  → fecha − 14 h
 *   - ventas.date                    fecha − creación = −1 h (±2 s)  → fecha − 6 h (código de agosto)
 *   - mascotas.medicalHistory[].date fecha − creación = +7 h (±2 s)  → fecha − 14 h
 * Fechas elegidas por el usuario (00:00 o 12:00 UTC) y cualquier otro caso NO se tocan.
 * Es idempotente: tras corregir, la diferencia queda en −7 h y ya no coincide con la firma.
 *
 * Uso:
 *   node migraciones/2026-11-corregir-fechas-tepic.js --uri "<mongodb uri>"            (simulación)
 *   node migraciones/2026-11-corregir-fechas-tepic.js --uri "<mongodb uri>" --aplicar  (escribe)
 * Contra una base que no sea la copia local (127.0.0.1:27018) exige además --autorizado-por-el-usuario.
 * Antes de escribir guarda un respaldo EJSON con los valores originales en ./respaldos-migracion/.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { EJSON } = require('bson');

const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const uri = arg('--uri');
const aplicar = args.includes('--aplicar');
const autorizado = args.includes('--autorizado-por-el-usuario');
if (!uri) throw new Error('Falta --uri');
const esCopiaLocal = /^mongodb:\/\/127\.0\.0\.1:27018\//.test(uri);
if (aplicar && !esCopiaLocal && !autorizado) {
  throw new Error('Para escribir fuera de la copia local se requiere --autorizado-por-el-usuario.');
}

const H = 3600000;
const firma = (fecha, id, horas) => fecha instanceof Date && id && id.getTimestamp &&
  Math.abs((fecha - id.getTimestamp()) - horas * H) <= 2000;

(async () => {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`Base: ${db.databaseName} — modo: ${aplicar ? 'APLICAR' : 'simulación'}`);

  const cambiosVentas = [];
  for await (const v of db.collection('ventas').find({}, { projection: { date: 1 } })) {
    if (firma(v.date, v._id, 7)) cambiosVentas.push({ _id: v._id, antes: v.date, despues: new Date(v.date - 14 * H), regla: '+7h' });
    else if (firma(v.date, v._id, -1)) cambiosVentas.push({ _id: v._id, antes: v.date, despues: new Date(v.date - 6 * H), regla: '-1h' });
  }

  const cambiosHistorial = [];
  for await (const m of db.collection('mascotas').find({ 'medicalHistory.0': { $exists: true } }, { projection: { medicalHistory: 1 } })) {
    for (const e of m.medicalHistory) {
      if (firma(e.date, e._id, 7)) cambiosHistorial.push({ mascota: m._id, entrada: e._id, antes: e.date, despues: new Date(e.date - 14 * H) });
    }
  }

  const resumen = r => cambiosVentas.filter(c => c.regla === r).length;
  console.log(`ventas.date: ${cambiosVentas.length} (+7h: ${resumen('+7h')}, -1h: ${resumen('-1h')})`);
  console.log(`mascotas.medicalHistory.date: ${cambiosHistorial.length}`);
  cambiosVentas.slice(0, 3).forEach(c => console.log(`  ej. venta ${c._id}: ${c.antes.toISOString()} → ${c.despues.toISOString()}`));

  if (!aplicar) { console.log('Simulación: no se escribió nada.'); await mongoose.disconnect(); return; }

  const dir = path.join(__dirname, 'respaldos-migracion');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `fechas-tepic-${db.databaseName}-${Date.now()}.json`);
  fs.writeFileSync(archivo, EJSON.stringify({ base: db.databaseName, fecha: new Date(), cambiosVentas, cambiosHistorial }, { relaxed: false }));
  console.log(`Respaldo: ${archivo}`);

  for (const c of cambiosVentas) {
    await db.collection('ventas').updateOne({ _id: c._id, date: c.antes }, { $set: { date: c.despues } });
  }
  for (const c of cambiosHistorial) {
    await db.collection('mascotas').updateOne(
      { _id: c.mascota },
      { $set: { 'medicalHistory.$[e].date': c.despues } },
      { arrayFilters: [{ 'e._id': c.entrada, 'e.date': c.antes }] }
    );
  }
  console.log('Aplicado.');
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });

/**
 * Liga los recordatorios de pago ANTERIORES a su cuenta por pagar (campo nuevo
 * Recordatorio.cuentaPorPagar), para que se completen solos cuando la cuenta se liquide.
 * Campo autorizado por el usuario el 2026-11-17. NO SE HA EJECUTADO EN PRODUCCIÓN.
 *
 * Qué hace y qué NO hace:
 *  - Solo AGREGA el campo cuentaPorPagar. No cambia título, fecha, relatedId, relatedModel ni nada más.
 *  - Solo liga cuando hay EXACTAMENTE una cuenta que corresponde; si hay 0 o varias, lo reporta y no lo toca.
 *  - Con --completar-liquidadas, además marca como completados los recordatorios cuya cuenta ya está
 *    pagada o cancelada (status 'completado', completadoPor.motivo = cuenta_pagada / cuenta_cancelada).
 *  - Idempotente: los recordatorios que ya tienen cuentaPorPagar se omiten.
 *  - Sin --aplicar solo muestra lo que haría. Fuera de 127.0.0.1:27018 exige --autorizado-por-el-usuario.
 *  - Guarda el estado previo en respaldos-migracion/ para poder revertir con --revertir <archivo>.
 *
 * Cómo encuentra la cuenta (en este orden):
 *  1. Compra recuperada cuyo recuperada.recordatorio es este recordatorio → su cuenta.
 *  2. Descripción "Pago de cuenta por compra <folio o id> por $X" → cuenta del mismo proveedor
 *     con ese folio (receiptNumber) o de esa compra (_id).
 *
 * Uso:
 *   node migraciones/2026-11-ligar-recordatorios-pago.js --uri "<uri>" [--completar-liquidadas]
 *   node migraciones/2026-11-ligar-recordatorios-pago.js --uri "<uri>" --aplicar [--completar-liquidadas] [--autorizado-por-el-usuario]
 *   node migraciones/2026-11-ligar-recordatorios-pago.js --uri "<uri>" --revertir <archivo.json> [--aplicar] [--autorizado-por-el-usuario]
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Recordatorio = require('../models/Recordatorio');
const CuentaPorPagar = require('../models/CuentaPorPagar');


const { cuentasCandidatas } = require('../helpers/recordatorioPago');

async function planear({ completarLiquidadas = false } = {}) {
  const recordatorios = await Recordatorio.find({ type: 'pago', cuentaPorPagar: { $exists: false } }).lean();
  const plan = [];
  const sinCuenta = [];
  for (const r of recordatorios) {
    const candidatas = await cuentasCandidatas(r);
    if (candidatas.length !== 1) {
      sinCuenta.push({ recordatorio: r._id, titulo: r.title, descripcion: r.description, candidatas: candidatas.length });
      continue;
    }
    const cuenta = candidatas[0];
    const liquidada = cuenta.status === 'pagado' || cuenta.status === 'cancelada';
    plan.push({
      recordatorio: r._id,
      cuenta: cuenta._id,
      statusCuenta: cuenta.status,
      completar: completarLiquidadas && liquidada && r.status === 'pendiente',
      antes: { status: r.status, completedAt: r.completedAt || null }
    });
  }
  return { plan, sinCuenta };
}

async function aplicarPlan(plan) {
  for (const p of plan) {
    const set = { cuentaPorPagar: p.cuenta };
    if (p.completar) {
      set.status = 'completado';
      set.completedAt = new Date();
      set.completadoPor = { motivo: p.statusCuenta === 'pagado' ? 'cuenta_pagada' : 'cuenta_cancelada' };
    }
    await Recordatorio.updateOne({ _id: p.recordatorio, cuentaPorPagar: { $exists: false } }, { $set: set });
  }
}

async function revertirPlan(plan) {
  for (const p of plan) {
    const update = { $unset: { cuentaPorPagar: 1 } };
    if (p.completar) {
      update.$set = { status: p.antes.status };
      update.$unset.completadoPor = 1;
      if (p.antes.completedAt) update.$set.completedAt = p.antes.completedAt; else update.$unset.completedAt = 1;
    }
    await Recordatorio.updateOne({ _id: p.recordatorio, cuentaPorPagar: p.cuenta }, update);
  }
}

module.exports = { planear, aplicarPlan, revertirPlan, cuentasCandidatas };

if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const uri = arg('--uri');
  const archivoRevertir = arg('--revertir');
  const aplicar = args.includes('--aplicar');
  const completarLiquidadas = args.includes('--completar-liquidadas');
  if (!uri) throw new Error('Falta --uri');
  if (aplicar && !/^mongodb:\/\/127\.0\.0\.1:27018\//.test(uri) && !args.includes('--autorizado-por-el-usuario')) {
    throw new Error('Para escribir fuera de la base local de pruebas se requiere --autorizado-por-el-usuario.');
  }
  (async () => {
    await mongoose.connect(uri);
    console.log(`Base: ${mongoose.connection.host}/${mongoose.connection.name}`);
    if (archivoRevertir) {
      const { plan } = JSON.parse(fs.readFileSync(archivoRevertir, 'utf8'));
      console.log(`Revertir ${plan.length} recordatorios${aplicar ? '' : ' (simulación)'}`);
      if (aplicar) await revertirPlan(plan.map(p => ({ ...p, recordatorio: new mongoose.Types.ObjectId(p.recordatorio), cuenta: new mongoose.Types.ObjectId(p.cuenta) })));
    } else {
      const { plan, sinCuenta } = await planear({ completarLiquidadas });
      console.log(`Se ligarían ${plan.length}; se completarían ${plan.filter(p => p.completar).length}; sin cuenta única: ${sinCuenta.length}`);
      sinCuenta.forEach(s => console.log(`  - sin ligar (${s.candidatas} candidatas): ${s.titulo} | ${s.descripcion}`));
      if (aplicar) {
        const dir = path.join(__dirname, 'respaldos-migracion');
        fs.mkdirSync(dir, { recursive: true });
        const archivo = path.join(dir, `recordatorios-ligados-${mongoose.connection.name}-${Date.now()}.json`);
        fs.writeFileSync(archivo, JSON.stringify({ plan, sinCuenta }, null, 2));
        await aplicarPlan(plan);
        console.log(`Aplicado. Respaldo para revertir: ${archivo}`);
      }
    }
    await mongoose.disconnect();
  })().catch(e => { console.error(e); process.exit(1); });
}

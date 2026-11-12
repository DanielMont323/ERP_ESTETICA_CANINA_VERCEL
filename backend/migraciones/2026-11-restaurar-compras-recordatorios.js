/**
 * Restaura las compras a crédito borradas (registradas del 12/oct/2026 en adelante) y sus cuentas por
 * pagar, a partir de los recordatorios de pago que dejaron. Autorizado por el usuario el 2026-11-12.
 *
 * Cada compra se crea como "recuperada": sin productos, sin mover inventario ni capas FIFO (esa
 * mercancía ya está contada en el stock), con total = monto del recordatorio. La deuda del proveedor
 * (currentDebt) no se toca: la compra original ya la había sumado y el borrado no la restó.
 *
 * Seguridad:
 *  - Lista cerrada de 16 compras (proveedor, folio o id original, monto). Cada una debe corresponder
 *    a exactamente un recordatorio de pago; si no, no se restaura ninguna.
 *  - Idempotente: si ya existe una compra recuperada de ese recordatorio, se omite.
 *  - Si ya existe una compra activa del mismo proveedor y folio, se omite (posible recaptura).
 *  - Sin --aplicar solo muestra lo que haría. Fuera de la copia local exige --autorizado-por-el-usuario.
 *  - Guarda los _id creados en respaldos-migracion/ para poder revertir con --revertir <archivo>.
 *
 * Uso:
 *   node migraciones/2026-11-restaurar-compras-recordatorios.js --uri "<uri>" --admin <correo>
 *   node migraciones/2026-11-restaurar-compras-recordatorios.js --uri "<uri>" --admin <correo> --aplicar [--autorizado-por-el-usuario]
 *   node migraciones/2026-11-restaurar-compras-recordatorios.js --uri "<uri>" --revertir <archivo.json> [--aplicar] [--autorizado-por-el-usuario]
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const uri = arg('--uri');
const email = arg('--admin');
const archivoRevertir = arg('--revertir');
const aplicar = args.includes('--aplicar');
if (!uri) throw new Error('Falta --uri');
if (aplicar && !/^mongodb:\/\/127\.0\.0\.1:27018\//.test(uri) && !args.includes('--autorizado-por-el-usuario')) {
  throw new Error('Para escribir fuera de la copia local se requiere --autorizado-por-el-usuario.');
}

const Compra = require('../models/Compra');
const CuentaPorPagar = require('../models/CuentaPorPagar');
const Recordatorio = require('../models/Recordatorio');
const Proveedor = require('../models/Proveedor');
const Usuario = require('../models/Usuario');
const { hoyCalendarioTepic } = require('../helpers/timezone');

// [proveedor, folio o _id de la compra borrada, monto del recordatorio]
const COMPRAS = [
  ['Padila', '6acec59f02f55c92e07bb5bd', 880.55],
  ['Padila', '6acec60002f55c92e07bb65e', 1164.40],
  ['Vet Shop', '6aced24b02f55c92e07bbfa2', 3675.86],
  ['Vet Shop Sin descuento', '6aced28a02f55c92e07bc013', 126.00],
  ['Divejal', '5715', 3474.62],
  ['Vet Shop Sin descuento', '0583', 337.50],
  ['Vet Shop', '0583', 591.60],
  ['Padila', '20779', 177.98],
  ['Padila', '20776', 1650.19],
  ['Vet Shop Sin descuento', '0593', 5357.43],
  ['Vet Shop Sin descuento', '6ae256d767a2ed06670e6785', 436.50],
  ['Padila', '20910', 1164.66],
  ['Divejal', '5771', 3314.16],
  ['Vet Shop Sin descuento', '6ae9395142246116e8998ff0', 250.00],
  ['Padila', '21010', 810.42],
  ['Vet Shop', '0603', 700.43]
];
const esIdMongo = s => /^[0-9a-f]{24}$/.test(s);
const fmt = n => n.toFixed(2);

async function revertir() {
  const r = JSON.parse(fs.readFileSync(archivoRevertir, 'utf8'));
  if (r.base !== mongoose.connection.name) throw new Error(`El archivo es de "${r.base}" y la conexión es a "${mongoose.connection.name}"`);
  for (const c of r.creadas) {
    const cuenta = await CuentaPorPagar.findById(c.cuenta).lean();
    if (cuenta && cuenta.payments && cuenta.payments.length) {
      console.log(`OMITIDA ${c.compra}: su cuenta por pagar ya tiene pagos`);
      continue;
    }
    console.log(`${aplicar ? 'Eliminando' : 'Se eliminaría'} compra recuperada ${c.compra} y cuenta ${c.cuenta}`);
    if (aplicar) {
      await CuentaPorPagar.deleteOne({ _id: c.cuenta, compra: c.compra });
      await Compra.deleteOne({ _id: c.compra, 'recuperada.origen': 'recordatorio_pago' });
    }
  }
}

async function restaurar() {
  if (!email) throw new Error('Falta --admin');
  const admin = await Usuario.findOne({ email, role: 'admin' }).lean();
  if (!admin) throw new Error(`No existe un admin con correo ${email}`);

  // 1. Emparejar cada compra con exactamente un recordatorio
  const plan = [];
  const errores = [];
  for (const [nombreProveedor, ref, monto] of COMPRAS) {
    const recs = await Recordatorio.find({
      type: 'pago',
      title: `Pago a proveedor - ${nombreProveedor}`,
      description: `Pago de cuenta por compra ${ref} por $${fmt(monto)}`
    }).lean();
    if (recs.length !== 1) { errores.push(`${nombreProveedor} ${ref}: ${recs.length} recordatorios`); continue; }
    const rec = recs[0];
    const proveedor = await Proveedor.findById(rec.relatedId).lean();
    if (!proveedor || proveedor.name !== nombreProveedor) { errores.push(`${nombreProveedor} ${ref}: proveedor no coincide`); continue; }
    plan.push({ nombreProveedor, ref, monto, rec, proveedor });
  }
  if (errores.length) throw new Error('No se restaura nada. ' + errores.join('; '));

  console.log(`Base: ${mongoose.connection.name} — admin: ${admin.name} — modo: ${aplicar ? 'APLICAR' : 'vista previa'}`);
  const creadas = [];
  let total = 0;
  for (const p of plan) {
    const folio = esIdMongo(p.ref) ? undefined : p.ref;
    const etiqueta = `${p.nombreProveedor.padEnd(23)} ${String(folio || '(sin folio)').padEnd(12)} $${fmt(p.monto).padStart(9)}`;
    if (await Compra.exists({ 'recuperada.recordatorio': p.rec._id })) { console.log(`OMITIDA (ya restaurada)  ${etiqueta}`); continue; }
    if (folio && await Compra.exists({ proveedor: p.proveedor._id, invoice: folio, status: { $ne: 'cancelada' } })) {
      console.log(`OMITIDA (ya existe una compra con ese folio) ${etiqueta}`);
      continue;
    }
    const registrada = hoyCalendarioTepic(p.rec._id.getTimestamp());
    const vence = p.rec.date;
    const nota = `Compra recuperada el 12/nov/2026 desde su recordatorio de pago (${p.rec._id}). `
      + `Referencia original: ${p.ref}. Sin productos; monto por confirmar con la factura.`;
    console.log(`${aplicar ? 'RESTAURADA' : 'Se restauraría'}  ${etiqueta}  registrada ${registrada.toISOString().slice(0, 10)}  vence ${vence.toISOString().slice(0, 10)}`);
    total += p.monto;
    if (!aplicar) continue;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const [compra] = await Compra.create([{
          proveedor: p.proveedor._id,
          items: [],
          type: 'credito',
          dueDate: vence,
          status: 'pendiente',
          user: p.rec.user || admin._id,
          invoice: folio,
          notes: nota,
          date: registrada,
          recuperada: {
            origen: 'recordatorio_pago',
            recordatorio: p.rec._id,
            referenciaOriginal: p.ref,
            monto: p.monto,
            restauradaEl: new Date(),
            nota
          }
        }], { session });
        const [cuenta] = await CuentaPorPagar.create([{
          proveedor: p.proveedor._id,
          compra: compra._id,
          receiptNumber: folio,
          hasIVA: false,
          subtotal: p.monto,
          ivaAmount: 0,
          monto: p.monto,
          montoBase: p.monto,
          descuentoDisponible: 0,
          saldo: p.monto,
          dueDate: vence,
          notes: nota
        }], { session });
        creadas.push({ compra: String(compra._id), cuenta: String(cuenta._id), recordatorio: String(p.rec._id), proveedor: p.nombreProveedor, ref: p.ref, monto: p.monto });
      });
    } finally {
      await session.endSession();
    }
  }
  console.log(`Total: $${fmt(total)}`);
  if (aplicar && creadas.length) {
    const dir = path.join(__dirname, 'respaldos-migracion');
    fs.mkdirSync(dir, { recursive: true });
    const archivo = path.join(dir, `compras-restauradas-${mongoose.connection.name}-${Date.now()}.json`);
    fs.writeFileSync(archivo, JSON.stringify({ base: mongoose.connection.name, fecha: new Date(), creadas }, null, 1));
    console.log(`Registro para revertir: ${archivo}`);
  }
}

(async () => {
  await mongoose.connect(uri);
  if (archivoRevertir) await revertir(); else await restaurar();
  await mongoose.disconnect();
})().catch(async e => { console.error('ERROR', e.message); await mongoose.disconnect(); process.exit(1); });

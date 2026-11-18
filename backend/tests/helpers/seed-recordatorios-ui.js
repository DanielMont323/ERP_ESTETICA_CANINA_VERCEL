// Llena la base local de pruebas erp-recordatorios-ui-test con datos INVENTADOS para revisar
// la pantalla de Recordatorios. Borra y recrea SOLO esa base (guardia abajo). Nunca toca Atlas.
//   node backend/tests/helpers/seed-recordatorios-ui.js
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

const backend = path.join(__dirname, '..', '..');
const env = dotenv.parse(fs.readFileSync(path.join(backend, '.env.test.local')));
const DB = 'erp-recordatorios-ui-test';
const uri = env.MONGODB_URI.replace(/\/[^/?]+\?/, `/${DB}?`);
if (!new RegExp(`^mongodb://127\\.0\\.0\\.1:27018/${DB}\\?`).test(uri)) throw new Error('Guardia: URI no permitida');

const Usuario = require('../../models/Usuario');
const Proveedor = require('../../models/Proveedor');
const Cliente = require('../../models/Cliente');
const Mascota = require('../../models/Mascota');
const CarnetVacunacion = require('../../models/CarnetVacunacion');
const CuentaPorPagar = require('../../models/CuentaPorPagar');
const Recordatorio = require('../../models/Recordatorio');
const Producto = require('../../models/Producto');
const Compra = require('../../models/Compra');
const InventoryLayer = require('../../models/InventoryLayer');
const { hoyTepic } = require('../../helpers/recordatoriosBandeja');

const DIA = 86400000;
const dia = (d, hora = '00:00:00') => new Date(new Date(`${hoyTepic()}T${hora}Z`).getTime() + d * DIA);

(async () => {
  await mongoose.connect(uri);
  if (mongoose.connection.name !== DB || mongoose.connection.host !== '127.0.0.1') throw new Error('Guardia: conexión inesperada');
  await mongoose.connection.db.dropDatabase();

  const admin = await Usuario.create({ name: 'Admin Ficticio', email: 'admin@ficticio.mx', password: `Fict-${Date.now()}`, role: 'admin' });
  const prov = await Proveedor.create({ name: 'Proveedor Ficticio', contact: 'N/A', phone: '3110000000', creditDays: 15 });
  const ana = await Cliente.create({ name: 'Ana Ficticia', phone: '3112223344' });
  const luis = await Cliente.create({ name: 'Luis Inventado', phone: '3115556677' });
  const toby = await Mascota.create({ name: 'Toby', type: 'perro', breed: 'Mestizo', weight: 8, gender: 'macho', owner: ana._id });
  const luna = await Mascota.create({ name: 'Luna', type: 'gato', breed: 'Criollo', weight: 4, gender: 'hembra', owner: luis._id });

  await CarnetVacunacion.create({
    mascota: toby._id, nombreMascota: 'Toby', especie: 'perro', raza: 'Mestizo', propietario: ana._id, nombrePropietario: 'Ana Ficticia',
    vacunas: [
      { vacuna: 'Desparasitante Demo', nombre: 'Desparasitante Demo', tipo: 'desparasitante', fecha: dia(-35, '12:00:00'), proximaDosis: dia(-5, '12:00:00') },
      { vacuna: 'Rabia Demo', nombre: 'Rabia Demo', tipo: 'vacuna', fecha: dia(-365, '12:00:00'), proximaDosis: dia(0, '12:00:00') }
    ]
  });
  await CarnetVacunacion.create({
    mascota: luna._id, nombreMascota: 'Luna', especie: 'gato', raza: 'Criollo', propietario: luis._id, nombrePropietario: 'Luis Inventado',
    vacunas: [{ vacuna: 'Triple felina Demo', nombre: 'Triple felina Demo', tipo: 'vacuna', fecha: dia(-330, '12:00:00'), proximaDosis: dia(4, '12:00:00') }]
  });

  const shampoo = await Producto.create({ name: 'Shampoo Demo 1L', sku: 'DEMO-SH', cost: 120, price: 220, stock: 10, category: 'General' });
  const toallas = await Producto.create({ name: 'Toallas Demo', sku: 'DEMO-TO', cost: 45, price: 90, stock: 20, category: 'General' });
  // Capas FIFO que cuadran con el stock (necesarias para los ajustes de inventario)
  for (const [prod, costo] of [[shampoo, 120], [toallas, 45]]) {
    await InventoryLayer.create({ producto: prod._id, quantity: prod.stock, initialQuantity: prod.stock, remainingQuantity: prod.stock, unitCost: costo, totalCost: costo * prod.stock, costSource: 'costo_capturado', source: 'ajuste_entrada', isInitialLayer: false, receivedDate: dia(-20, '12:00:00'), notes: 'Datos de prueba' });
    await Producto.updateOne({ _id: prod._id }, { $set: { fifoInitialized: true } });
  }
  const compra = await Compra.create({ proveedor: prov._id, type: 'credito', user: admin._id, date: dia(-15, '12:00:00'), dueDate: dia(0, '12:00:00'), invoice: 'FAC-DEMO-77',
    items: [{ product: shampoo._id, quantity: 10, baseUnitCost: 120, unitCost: 120, hasTax: false }, { product: toallas._id, quantity: 6, baseUnitCost: 50, unitCost: 50, hasTax: false }] });
  const cuenta = await CuentaPorPagar.create({ proveedor: prov._id, monto: 1500, montoBase: 1500, subtotal: 1500, saldo: 1500, dueDate: dia(0, '12:00:00'), receiptNumber: 'DEMO-1', compra: compra._id,
    payments: [{ amount: 500, paymentMethod: 'efectivo', user: admin._id, date: dia(-3, '12:00:00') }] });
  await CuentaPorPagar.updateOne({ _id: cuenta._id }, { $set: { saldo: 1000 } });
  await Recordatorio.create([
    { title: 'Pago a proveedor - Proveedor Ficticio', description: 'Pago de cuenta por compra DEMO-1 por $1500.00', date: dia(0, '12:00:00'), type: 'pago', priority: 'alta', relatedId: prov._id, relatedModel: 'Proveedor', cuentaPorPagar: cuenta._id, user: admin._id },
    { title: 'Pagar renta (demo)', description: 'Recordatorio manual vencido', date: dia(-2), type: 'pago', priority: 'alta', user: admin._id },
    { title: 'Llamar para vacuna de Max (demo)', description: 'Recordatorio manual de vacuna', date: dia(0), type: 'vacuna', priority: 'media', user: admin._id },
    { title: 'Revisar inventario (demo)', date: dia(6), type: 'inventario', priority: 'baja', user: admin._id },
    { title: 'Mantenimiento secadora (demo)', date: dia(-10), type: 'mantenimiento', priority: 'media', status: 'completado', completedAt: new Date(Date.now() - 3 * DIA), user: admin._id }
  ]);
  console.log(`Listo: ${DB}. Usuario admin _id=${admin._id}`);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });

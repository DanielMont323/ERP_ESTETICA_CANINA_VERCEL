// Compras recuperadas desde recordatorios de pago: sin productos, sin inventario.
const h = require('./helpers/app');
const mongoose = require('mongoose');
const Compra = require('../models/Compra');
const CuentaPorPagar = require('../models/CuentaPorPagar');
const { InventoryLayer, InventoryMovement, Producto } = h.models;

let admin, base;
beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

async function recuperada(monto = 880.55) {
  const compra = await Compra.create({
    proveedor: base.proveedor._id, items: [], type: 'credito', status: 'pendiente', user: admin.userId,
    dueDate: new Date('2026-10-29T12:00:00Z'), date: new Date('2026-10-13T12:00:00Z'), invoice: '20779',
    recuperada: { origen: 'recordatorio_pago', recordatorio: new mongoose.Types.ObjectId(), referenciaOriginal: '20779', monto, restauradaEl: new Date() }
  });
  const cuenta = await CuentaPorPagar.create({
    proveedor: base.proveedor._id, compra: compra._id, receiptNumber: '20779', hasIVA: false,
    subtotal: monto, ivaAmount: 0, monto, montoBase: monto, saldo: monto, dueDate: compra.dueDate
  });
  return { compra, cuenta };
}

test('una compra recuperada sin productos toma su total del monto recuperado', async () => {
  const { compra } = await recuperada(880.55);
  expect(compra.total).toBe(880.55);
  expect(compra.baseTotal).toBe(880.55);
  const r = await h.request(h.app).get('/api/compras').set(h.auth(admin.token));
  expect(r.status).toBe(200);
  expect(r.body.data[0].recuperada.origen).toBe('recordatorio_pago');
  expect(r.body.data[0].items).toEqual([]);
});

test('no se puede editar una compra recuperada (no debe sumar inventario)', async () => {
  const p = await h.producto();
  const { compra } = await recuperada();
  const r = await h.request(h.app).put('/api/compras/' + compra._id).set(h.auth(admin.token))
    .send({ items: [{ product: p._id, quantity: 5, unitCost: 10, hasTax: false }] });
  expect(r.status).toBe(409);
  expect((await Producto.findById(p._id)).stock).toBe(0);
  expect(await InventoryLayer.countDocuments({})).toBe(0);
});

test('cancelar una compra recuperada cancela su cuenta y no toca inventario', async () => {
  const { compra, cuenta } = await recuperada();
  const r = await h.request(h.app).delete('/api/compras/' + compra._id).set(h.auth(admin.token));
  expect(r.status).toBe(200);
  expect((await Compra.findById(compra._id)).status).toBe('cancelada');
  expect((await CuentaPorPagar.findById(cuenta._id)).status).toBe('cancelada');
  expect(await InventoryMovement.countDocuments({})).toBe(0);
});

test('se puede registrar el pago de su cuenta por pagar', async () => {
  const { cuenta } = await recuperada(500);
  const r = await h.request(h.app).patch(`/api/cuentas-por-pagar/${cuenta._id}/pagar`).set(h.auth(admin.token))
    .send({ amount: 500, paymentMethod: 'transferencia', user: admin.userId });
  expect(r.status).toBe(200);
  expect((await CuentaPorPagar.findById(cuenta._id)).saldo).toBe(0);
});

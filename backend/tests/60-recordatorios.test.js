// Recordatorios: retrasados visibles, filtro de completados, aviso al dueño, carnet y pagos ligados.
// Corre solo en 127.0.0.1:27018/erp-jest-test (guardia en tests/setup/env.js y helpers/app.js). Datos inventados.
const h = require('./helpers/app');
const Recordatorio = require('../models/Recordatorio');
const CarnetVacunacion = require('../models/CarnetVacunacion');
const CuentaPorPagar = require('../models/CuentaPorPagar');
const { estadoPorFecha, hoyTepic } = require('../helpers/recordatoriosBandeja');
const { planear, aplicarPlan, revertirPlan } = require('../migraciones/2026-11-ligar-recordatorios-pago');

let admin, base;
const DIA = 86400000;
// Día de calendario relativo a HOY EN TEPIC, guardado como lo guarda el formulario (AAAA-MM-DD → 00:00Z)
const dia = (delta) => new Date(new Date(`${hoyTepic()}T00:00:00Z`).getTime() + delta * DIA);
const bandeja = (vista = 'pendientes', token = admin.token) =>
  h.request(h.app).get(`/api/recordatorios/bandeja?vista=${vista}`).set(h.auth(token));
const crear = (extra) => Recordatorio.create({ title: 'Prueba', type: 'otro', date: dia(0), ...extra });

beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

describe('estado por fecha (Tepic, UTC-7)', () => {
  const ahora = s => new Date(s);
  test('17/nov 23:30 en Tepic (18/nov 06:30 UTC): el recordatorio del 17 sigue siendo de HOY', () => {
    expect(estadoPorFecha(new Date('2026-11-17T00:00:00Z'), ahora('2026-11-18T06:30:00Z'))).toBe('hoy');
    expect(estadoPorFecha(new Date('2026-11-17T12:00:00Z'), ahora('2026-11-18T06:30:00Z'))).toBe('hoy');
  });
  test('18/nov 00:00 en Tepic (07:00 UTC): el del 17 pasa a RETRASADO y el del 18 es de hoy', () => {
    expect(estadoPorFecha(new Date('2026-11-17T00:00:00Z'), ahora('2026-11-18T07:00:00Z'))).toBe('retrasado');
    expect(estadoPorFecha(new Date('2026-11-18T00:00:00Z'), ahora('2026-11-18T07:00:00Z'))).toBe('hoy');
  });
  test('17/nov 08:00 en Tepic: el de mañana es pendiente (no se adelanta)', () => {
    expect(estadoPorFecha(new Date('2026-11-18T00:00:00Z'), ahora('2026-11-17T15:00:00Z'))).toBe('pendiente');
    expect(estadoPorFecha(new Date('2026-11-18T12:00:00Z'), ahora('2026-11-17T15:00:00Z'))).toBe('pendiente');
  });
});

test('1, 5, 6, 9: retrasado visible, hoy, futuro; completados fuera de pendientes y visibles en su filtro', async () => {
  const ayer = await crear({ title: 'Ayer', date: dia(-1) });
  const hoy = await crear({ title: 'Hoy', date: dia(0) });
  const futuro = await crear({ title: 'Futuro', date: dia(3) });
  const hecho = await crear({ title: 'Hecho', date: dia(-2) });
  expect((await h.request(h.app).patch(`/api/recordatorios/${hecho._id}/complete`).set(h.auth(admin.token))).status).toBe(200);

  const p = (await bandeja('pendientes')).body.data;
  const estado = t => p.items.find(i => i.titulo === t)?.estado;
  expect(estado('Ayer')).toBe('retrasado');
  expect(estado('Hoy')).toBe('hoy');
  expect(estado('Futuro')).toBe('pendiente');
  expect(estado('Hecho')).toBeUndefined();
  expect(p.items.map(i => i.titulo)).toEqual(['Ayer', 'Hoy', 'Futuro']); // retrasados primero
  expect(p.conteo).toMatchObject({ retrasado: 1, hoy: 1, pendiente: 1 });

  const c = (await bandeja('completados')).body.data;
  expect(c.items.map(i => i.titulo)).toEqual(['Hecho']);
  expect(c.items[0].completado).toMatchObject({ motivo: 'manual', nombre: 'Usuario admin' });

  const t = (await bandeja('todos')).body.data;
  expect(t.items).toHaveLength(4);
  // No se tocó ningún dato de los demás
  const ayerDb = await Recordatorio.findById(ayer._id).lean();
  expect(ayerDb.status).toBe('pendiente');
  expect(ayerDb.date.toISOString()).toBe(ayer.date.toISOString());
  void hoy; void futuro;
});

test('7 y 8: avisar al dueño no completa; guarda fecha, hora y usuario; no se sobrescribe', async () => {
  const r = await crear({ title: 'Vacuna rabia', type: 'vacuna', date: dia(0) });
  const antes = Date.now();
  const res = await h.request(h.app).patch(`/api/recordatorios/${r._id}/notificar-dueno`).set(h.auth(admin.token));
  expect(res.status).toBe(200);
  const db = await Recordatorio.findById(r._id).lean();
  expect(db.status).toBe('pendiente');
  expect(db.duenoNotificado.nombre).toBe('Usuario admin');
  expect(String(db.duenoNotificado.usuario)).toBe(String(admin.userId));
  expect(db.duenoNotificado.fecha.getTime()).toBeGreaterThanOrEqual(antes - 1000);

  const otra = await h.request(h.app).patch(`/api/recordatorios/${r._id}/notificar-dueno`).set(h.auth(admin.token));
  expect(otra.status).toBe(409);
  const db2 = await Recordatorio.findById(r._id).lean();
  expect(db2.duenoNotificado.fecha.getTime()).toBe(db.duenoNotificado.fecha.getTime());

  const item = (await bandeja()).body.data.items.find(i => i.titulo === 'Vacuna rabia');
  expect(item.estado).toBe('hoy');
  expect(item.duenoNotificado.nombre).toBe('Usuario admin');

  const pago = await crear({ title: 'Pago', type: 'pago' });
  expect((await h.request(h.app).patch(`/api/recordatorios/${pago._id}/notificar-dueno`).set(h.auth(admin.token))).status).toBe(400);
});

describe('carnet: próxima dosis de vacunas y desparasitantes', () => {
  async function carnet(vacunas) {
    return CarnetVacunacion.create({
      mascota: base.mascota._id, nombreMascota: 'Firulais', especie: 'perro', raza: 'Mestizo',
      propietario: base.cliente._id, nombrePropietario: 'Cliente Prueba', vacunas
    });
  }

  test('una desparasitación vencida aparece como retrasada (antes desaparecía)', async () => {
    await carnet([{ vacuna: 'Desparasitante X', nombre: 'Desparasitante X', tipo: 'desparasitante', fecha: dia(-40), proximaDosis: dia(-5) }]);
    const items = (await bandeja()).body.data.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ origen: 'carnet', tipo: 'desparasitante', estado: 'retrasado', titulo: 'Desparasitación: Desparasitante X' });
    expect(items[0].dueno).toMatchObject({ nombre: 'Cliente Prueba', telefono: '3111111111' });
    expect(items[0].descripcion).toMatch(/Firulais/);
  });

  test('avisar al dueño y luego completar: solo escribe esa aplicación', async () => {
    const c = await carnet([
      { vacuna: 'Rabia', nombre: 'Rabia', tipo: 'vacuna', fecha: dia(-365), proximaDosis: dia(0), observaciones: 'original' },
      { vacuna: 'Parvo', nombre: 'Parvo', tipo: 'vacuna', fecha: dia(-30), proximaDosis: dia(10) }
    ]);
    const [rabia, parvo] = c.vacunas;
    const url = (ap, accion) => `/api/recordatorios/carnet/${c._id}/${ap._id}/${accion}`;
    const antes = await CarnetVacunacion.findById(c._id).lean();

    expect((await h.request(h.app).patch(url(rabia, 'notificar-dueno')).set(h.auth(admin.token))).status).toBe(200);
    expect((await h.request(h.app).patch(url(rabia, 'notificar-dueno')).set(h.auth(admin.token))).status).toBe(409);
    let item = (await bandeja()).body.data.items.find(i => i.titulo === 'Vacuna: Rabia');
    expect(item.estado).toBe('hoy'); // avisar NO completa
    expect(item.duenoNotificado.nombre).toBe('Usuario admin');

    expect((await h.request(h.app).patch(url(rabia, 'atender')).set(h.auth(admin.token))).status).toBe(200);
    const p = (await bandeja()).body.data.items;
    expect(p.map(i => i.titulo)).toEqual(['Vacuna: Parvo']);
    item = (await bandeja('completados')).body.data.items[0];
    expect(item).toMatchObject({ titulo: 'Vacuna: Rabia', estado: 'completado' });
    expect(item.duenoNotificado).toBeTruthy(); // se conserva el aviso

    const despues = await CarnetVacunacion.findById(c._id).lean();
    expect(despues.vacunas[0]).toMatchObject({ nombre: 'Rabia', observaciones: 'original' });
    expect(despues.vacunas[0].fecha.toISOString()).toBe(antes.vacunas[0].fecha.toISOString());
    expect(despues.vacunas[1]).toEqual(antes.vacunas[1]); // la otra aplicación queda idéntica
    expect(despues.updatedAt.toISOString()).toBe(antes.updatedAt.toISOString());
    void parvo;
  });

  test('"Se aplicó aquí": agrega la nueva aplicación (mismo producto y tipo), cierra la anterior y crea el siguiente recordatorio', async () => {
    const c = await carnet([{ vacuna: 'Desp X', nombre: 'Desp X', tipo: 'desparasitante', fecha: dia(-35), proximaDosis: dia(-5), diasProximaDosis: 30, observaciones: 'original' }]);
    const ap = c.vacunas[0];
    const url = `/api/recordatorios/carnet/${c._id}/${ap._id}/aplicar`;
    expect((await h.request(h.app).post(url).set(h.auth(admin.token)).send({ fecha: hoyTepic(), diasProximaDosis: 30 })).status).toBe(201);
    // doble clic: no duplica
    expect((await h.request(h.app).post(url).set(h.auth(admin.token)).send({ fecha: hoyTepic(), diasProximaDosis: 30 })).status).toBe(409);

    const db = await CarnetVacunacion.findById(c._id).lean();
    expect(db.vacunas).toHaveLength(2);
    expect(db.vacunas[0]).toMatchObject({ nombre: 'Desp X', observaciones: 'original', atendido: { nombre: 'Usuario admin' } });
    expect(db.vacunas[1]).toMatchObject({ vacuna: 'Desp X', nombre: 'Desp X', tipo: 'desparasitante', diasProximaDosis: 30 });
    expect(db.vacunas[1].fecha.toISOString().slice(0, 10)).toBe(hoyTepic());
    expect(db.vacunas[1].proximaDosis.toISOString().slice(0, 10)).toBe(new Date(dia(30)).toISOString().slice(0, 10));

    const p = (await bandeja()).body.data.items;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ estado: 'pendiente', dia: new Date(dia(30)).toISOString().slice(0, 10) });
  });

  test('"Se aplicó aquí": fecha pasada permitida, futura no; sin próxima dosis no crea recordatorio', async () => {
    const c = await carnet([{ vacuna: 'Rabia', nombre: 'Rabia', tipo: 'vacuna', fecha: dia(-400), proximaDosis: dia(-35) }]);
    const url = `/api/recordatorios/carnet/${c._id}/${c.vacunas[0]._id}/aplicar`;
    const manana = new Date(dia(1)).toISOString().slice(0, 10);
    expect((await h.request(h.app).post(url).set(h.auth(admin.token)).send({ fecha: manana })).status).toBe(400);
    expect((await h.request(h.app).post(url).set(h.auth(admin.token)).send({ diasProximaDosis: -3 })).status).toBe(400);
    const ayer = new Date(dia(-1)).toISOString().slice(0, 10);
    expect((await h.request(h.app).post(url).set(h.auth(admin.token)).send({ fecha: ayer })).status).toBe(201);
    const db = await CarnetVacunacion.findById(c._id).lean();
    expect(db.vacunas[1].fecha.toISOString()).toBe(`${ayer}T12:00:00.000Z`);
    expect(db.vacunas[1].proximaDosis).toBeNull();
    expect((await bandeja()).body.data.items).toHaveLength(0);
  });

  test('si ya se aplicó la siguiente dosis, la anterior cuenta como completada (sin escribir nada)', async () => {
    await carnet([
      { vacuna: 'Desp', nombre: 'Desp', tipo: 'desparasitante', fecha: dia(-60), proximaDosis: dia(-30) },
      { vacuna: 'Desp', nombre: 'Desp', tipo: 'desparasitante', fecha: dia(-29), proximaDosis: dia(1) }
    ]);
    const p = (await bandeja()).body.data.items;
    expect(p).toHaveLength(1);
    expect(p[0].estado).toBe('pendiente');
    const c = (await bandeja('completados')).body.data.items;
    expect(c[0].completado.motivo).toBe('siguiente_dosis_aplicada');
  });
});

describe('recordatorios de pago ligados a la cuenta por pagar', () => {
  async function compraCredito() {
    const p = await h.producto();
    const res = await h.request(h.app).post('/api/compras').set(h.auth(admin.token)).send({
      proveedor: base.proveedor._id, type: 'credito', user: admin.userId,
      items: [{ product: p._id, quantity: 2, unitCost: 100, hasTax: false, taxRate: 0.16, costIncludesTax: false }]
    });
    expect(res.status).toBe(201);
    const cuenta = await CuentaPorPagar.findOne({ compra: res.body.data._id });
    const rec = await Recordatorio.findOne({ type: 'pago' }).lean();
    return { cuenta, rec };
  }

  test('la compra a crédito crea el recordatorio ligado y se completa solo al pagar', async () => {
    const { cuenta, rec } = await compraCredito();
    expect(String(rec.cuentaPorPagar)).toBe(String(cuenta._id));
    expect(rec).toMatchObject({ relatedModel: 'Proveedor', status: 'pendiente' }); // lo demás igual que antes

    // Abono parcial: sigue pendiente
    let r = await h.request(h.app).patch(`/api/cuentas-por-pagar/${cuenta._id}/pagar`).set(h.auth(admin.token))
      .send({ amount: 50, paymentMethod: 'efectivo', user: admin.userId });
    expect(r.status).toBe(200);
    expect((await Recordatorio.findById(rec._id).lean()).status).toBe('pendiente');

    r = await h.request(h.app).patch(`/api/cuentas-por-pagar/${cuenta._id}/pagar`).set(h.auth(admin.token))
      .send({ amount: 150, paymentMethod: 'efectivo', user: admin.userId });
    expect(r.status).toBe(200);
    const db = await Recordatorio.findById(rec._id).lean();
    expect(db.status).toBe('completado');
    expect(db.completadoPor.motivo).toBe('cuenta_pagada');
  });

  test('completar a mano el recordatorio de pago apaga su alerta aunque la cuenta siga abierta', async () => {
    const { cuenta, rec } = await compraCredito();
    expect((await h.request(h.app).patch(`/api/recordatorios/${rec._id}/complete`).set(h.auth(admin.token))).status).toBe(200);
    const d = (await bandeja()).body.data;
    expect(d.items).toHaveLength(0);
    expect(d.cuentasConRecordatorio).toEqual([String(cuenta._id)]); // la campana no repite la cuenta
    expect((await CuentaPorPagar.findById(cuenta._id).lean()).status).toBe('pendiente'); // la cuenta no se toca
  });

  test('doble clic: el detalle trae la compra (con productos) y la cuenta ligada, sin escribir nada', async () => {
    const { cuenta, rec } = await compraCredito();
    await h.request(h.app).patch(`/api/cuentas-por-pagar/${cuenta._id}/pagar`).set(h.auth(admin.token))
      .send({ amount: 80, paymentMethod: 'transferencia', user: admin.userId });
    const antes = await Recordatorio.findById(rec._id).lean();
    const r = await h.request(h.app).get(`/api/recordatorios/${rec._id}/detalle-pago`).set(h.auth(admin.token));
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.liga).toBe('directa');
    expect(d.cuenta).toMatchObject({ proveedor: { nombre: 'Proveedor Prueba' }, status: 'pendiente', monto: 200, pagado: 80, saldo: 120 });
    expect(d.cuenta.pagos).toEqual([expect.objectContaining({ monto: 80, metodo: 'transferencia', usuario: 'Usuario admin' })]);
    expect(d.compra).toMatchObject({ tipo: 'credito', total: 200 });
    expect(d.compra.productos).toEqual([expect.objectContaining({ cantidad: 2, costoUnitario: 100 })]);
    expect(d.compra.productos[0].nombre).toMatch(/^Producto /);
    expect(await Recordatorio.findById(rec._id).lean()).toEqual(antes);
  });

  test('detalle de un recordatorio viejo sin liga: la cuenta se deduce por el folio (solo lectura)', async () => {
    const { cuenta } = await compraCredito();
    await Recordatorio.deleteMany({}); // base de jest
    await CuentaPorPagar.updateOne({ _id: cuenta._id }, { $set: { receiptNumber: 'F-9' } });
    const viejo = await Recordatorio.create({ title: 'Pago viejo', description: 'Pago de cuenta por compra F-9 por $200.00', date: dia(-1), type: 'pago', relatedId: base.proveedor._id, relatedModel: 'Proveedor' });
    const manual = await Recordatorio.create({ title: 'Pagar renta', date: dia(0), type: 'pago' });
    const otro = await Recordatorio.create({ title: 'Otro', date: dia(0), type: 'otro' });
    const get = id => h.request(h.app).get(`/api/recordatorios/${id}/detalle-pago`).set(h.auth(admin.token));

    const d = (await get(viejo._id)).body.data;
    expect(d.liga).toBe('deducida');
    expect(String(d.cuenta._id)).toBe(String(cuenta._id));
    expect((await Recordatorio.findById(viejo._id).lean()).cuentaPorPagar).toBeUndefined(); // no se escribió la liga
    expect((await get(manual._id)).body.data).toEqual({ liga: 'ninguna', cuenta: null, compra: null });
    expect((await get(otro._id)).status).toBe(400);
  });

  test('cancelar la cuenta lo completa; reactivarla lo reabre', async () => {
    const { cuenta, rec } = await compraCredito();
    expect((await h.request(h.app).delete(`/api/cuentas-por-pagar/${cuenta._id}`).set(h.auth(admin.token))).status).toBe(200);
    expect((await Recordatorio.findById(rec._id).lean()).completadoPor.motivo).toBe('cuenta_cancelada');
    expect((await h.request(h.app).patch(`/api/cuentas-por-pagar/${cuenta._id}/reactivate`).set(h.auth(admin.token))).status).toBe(200);
    const db = await Recordatorio.findById(rec._id).lean();
    expect(db.status).toBe('pendiente');
    expect(db.completadoPor).toBeUndefined();
  });

  test('migración de recordatorios viejos: liga por folio, solo agrega el campo y se puede revertir', async () => {
    const { cuenta } = await compraCredito();
    await Recordatorio.deleteMany({}); // base de jest: se simula un recordatorio viejo sin liga
    await CuentaPorPagar.updateOne({ _id: cuenta._id }, { $set: { receiptNumber: 'F-123', status: 'pagado', saldo: 0 } });
    const viejo = await Recordatorio.create({
      title: 'Pago a proveedor - Proveedor Prueba', description: 'Pago de cuenta por compra F-123 por $200.00',
      date: dia(-10), type: 'pago', priority: 'alta', relatedId: base.proveedor._id, relatedModel: 'Proveedor'
    });
    const ambiguo = await Recordatorio.create({ title: 'Otro', description: 'Pago de cuenta por compra NO-EXISTE por $1', date: dia(-1), type: 'pago' });
    const antes = await Recordatorio.findById(viejo._id).lean();

    const { plan, sinCuenta } = await planear({ completarLiquidadas: true });
    expect(plan).toHaveLength(1);
    expect(sinCuenta.map(s => String(s.recordatorio))).toEqual([String(ambiguo._id)]);
    await aplicarPlan(plan);
    const despues = await Recordatorio.findById(viejo._id).lean();
    expect(String(despues.cuentaPorPagar)).toBe(String(cuenta._id));
    expect(despues.status).toBe('completado');
    expect(despues).toMatchObject({ title: antes.title, description: antes.description, relatedModel: 'Proveedor' });
    expect(despues.date.toISOString()).toBe(antes.date.toISOString());

    await revertirPlan(plan);
    const revertido = await Recordatorio.findById(viejo._id).lean();
    expect(revertido.cuentaPorPagar).toBeUndefined();
    expect(revertido.status).toBe('pendiente');
    expect((await planear()).plan).toHaveLength(1); // idempotente: se puede volver a planear
  });
});

test('12: los recordatorios existentes (sin campos nuevos) siguen funcionando igual', async () => {
  // Simula un documento viejo insertado directo, sin los campos nuevos
  const { insertedId } = await Recordatorio.collection.insertOne({
    title: 'Viejo', date: dia(-3), type: 'pago', priority: 'alta', status: 'pendiente', createdAt: new Date(), __v: 0
  });
  const lista = await h.request(h.app).get('/api/recordatorios').set(h.auth(admin.token));
  expect(lista.status).toBe(200);
  expect(lista.body.data[0].title).toBe('Viejo');
  const item = (await bandeja()).body.data.items[0];
  expect(item).toMatchObject({ titulo: 'Viejo', estado: 'retrasado', duenoNotificado: null, cuentaPorPagar: null });
  // Editarlo con el formulario de siempre no agrega campos vacíos
  await h.request(h.app).put(`/api/recordatorios/${insertedId}`).set(h.auth(admin.token)).send({ title: 'Viejo editado' });
  const db = await Recordatorio.collection.findOne({ _id: insertedId });
  expect(Object.keys(db).sort()).toEqual(['__v', '_id', 'createdAt', 'date', 'priority', 'status', 'title', 'type']);
});

test('"Ver automáticos" ya no regresa vacío por falta de sesión', async () => {
  await CarnetVacunacion.create({
    mascota: base.mascota._id, nombreMascota: 'Firulais', especie: 'perro', raza: 'Mestizo',
    propietario: base.cliente._id, nombrePropietario: 'Cliente Prueba',
    vacunas: [{ vacuna: 'Rabia', nombre: 'Rabia', fecha: dia(-300), proximaDosis: dia(2) }]
  });
  const r = await h.request(h.app).get('/api/recordatorios/automatic/all').set(h.auth(admin.token));
  expect(r.status).toBe(200);
  expect(r.body.data.some(x => x.type === 'vacuna')).toBe(true);
});

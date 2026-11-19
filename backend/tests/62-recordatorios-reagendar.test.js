// Reagendar el recordatorio de próxima dosis del carnet: la fecha original (proximaDosis) no se toca,
// la nueva queda en el historial "reagendado" y la bandeja usa la fecha vigente. Datos inventados.
const h = require('./helpers/app');
const CarnetVacunacion = require('../models/CarnetVacunacion');
const { hoyTepic } = require('../helpers/recordatoriosBandeja');

let admin, base;
const DIA = 86400000;
const dia = (delta) => new Date(new Date(`${hoyTepic()}T00:00:00Z`).getTime() + delta * DIA);
const diaISO = (delta) => dia(delta).toISOString().slice(0, 10);
const bandeja = (vista = 'pendientes') =>
  h.request(h.app).get(`/api/recordatorios/bandeja?vista=${vista}`).set(h.auth(admin.token));
const reagendar = (c, ap, body) =>
  h.request(h.app).patch(`/api/recordatorios/carnet/${c._id}/${ap._id}/reagendar`).set(h.auth(admin.token)).send(body);

beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
  base = await h.seedBase();
});
afterAll(h.close);

const carnet = (vacunas) => CarnetVacunacion.create({
  mascota: base.mascota._id, nombreMascota: 'Firulais', especie: 'perro', raza: 'Mestizo',
  propietario: base.cliente._id, nombrePropietario: 'Cliente Prueba', vacunas
});

test('reagendar un retrasado lo mueve a la nueva fecha sin tocar la próxima dosis original', async () => {
  const c = await carnet([{ vacuna: 'Desp X', nombre: 'Desp X', tipo: 'desparasitante', fecha: dia(-35), proximaDosis: dia(-5) }]);
  const ap = c.vacunas[0];
  const r = await reagendar(c, ap, { fecha: diaISO(4), nota: 'el dueño pidió el sábado' });
  expect(r.status).toBe(200);

  const item = (await bandeja()).body.data.items.find(i => i.aplicacionId === String(ap._id));
  expect(item.estado).toBe('pendiente');
  expect(item.dia).toBe(diaISO(4));
  expect(new Date(item.fechaOriginal).toISOString()).toBe(dia(-5).toISOString());
  expect(item.reagendado).toMatchObject({ nota: 'el dueño pidió el sábado', nombre: 'Usuario admin', veces: 1 });

  const db = await CarnetVacunacion.findById(c._id).lean();
  expect(db.vacunas[0].proximaDosis.toISOString()).toBe(dia(-5).toISOString());
  expect(db.vacunas[0].reagendado).toHaveLength(1);
  expect(db.vacunas[0].reagendado[0].fecha.toISOString()).toBe(`${diaISO(4)}T12:00:00.000Z`);
});

test('se puede reagendar varias veces y queda todo el historial', async () => {
  const c = await carnet([{ vacuna: 'Rabia', nombre: 'Rabia', fecha: dia(-300), proximaDosis: dia(2) }]);
  const ap = c.vacunas[0];
  expect((await reagendar(c, ap, { fecha: diaISO(5) })).status).toBe(200);
  expect((await reagendar(c, ap, { fecha: diaISO(0) })).status).toBe(200);
  const item = (await bandeja()).body.data.items.find(i => i.aplicacionId === String(ap._id));
  expect(item.estado).toBe('hoy');
  expect(item.reagendado.veces).toBe(2);
  expect(item.reagendado.anterior.slice(0, 10)).toBe(diaISO(5));
  const db = await CarnetVacunacion.findById(c._id).lean();
  expect(db.vacunas[0].reagendado.map(x => x.fecha.toISOString().slice(0, 10))).toEqual([diaISO(5), diaISO(0)]);
});

test('rechaza fechas inválidas, pasadas o iguales, y los recordatorios ya completados', async () => {
  const c = await carnet([
    { vacuna: 'Rabia', nombre: 'Rabia', fecha: dia(-300), proximaDosis: dia(2) },
    { vacuna: 'Parvo', nombre: 'Parvo', fecha: dia(-30), proximaDosis: dia(1) }
  ]);
  const [rabia, parvo] = c.vacunas;
  expect((await reagendar(c, rabia, { fecha: '15/12/2026' })).status).toBe(400);
  expect((await reagendar(c, rabia, {})).status).toBe(400);
  expect((await reagendar(c, rabia, { fecha: diaISO(-1) })).status).toBe(400);
  expect((await reagendar(c, rabia, { fecha: diaISO(2) })).status).toBe(400);

  expect((await h.request(h.app).patch(`/api/recordatorios/carnet/${c._id}/${parvo._id}/atender`).set(h.auth(admin.token))).status).toBe(200);
  expect((await reagendar(c, parvo, { fecha: diaISO(6) })).status).toBe(409);

  const db = await CarnetVacunacion.findById(c._id).lean();
  expect(db.vacunas.every(v => !v.reagendado || v.reagendado.length === 0)).toBe(true);
});

test('el dashboard viejo de recordatorios también usa la fecha reagendada', async () => {
  const c = await carnet([{ vacuna: 'Rabia', nombre: 'Rabia', fecha: dia(-300), proximaDosis: dia(-3) }]);
  expect((await reagendar(c, c.vacunas[0], { fecha: diaISO(1) })).status).toBe(200);
  const r = await h.request(h.app).get('/api/recordatorios/dashboard').set(h.auth(admin.token));
  expect(r.status).toBe(200);
  const v = r.body.data.vaccines.find(x => String(x.vacunaId) === String(c.vacunas[0]._id));
  expect(v).toBeTruthy(); // antes estaba vencida y no salía; ahora es de mañana
  expect(new Date(v.date).toISOString().slice(0, 10)).toBe(diaISO(1));
});

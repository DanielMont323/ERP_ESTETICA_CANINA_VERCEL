// Seguridad: registro, lista de usuarios, bloqueo por intentos, cambio de contraseña, CORS.
const h = require('./helpers/app');
const { Usuario } = h.models;

let admin;
beforeEach(async () => {
  await h.resetAislado();
  admin = await h.login('admin');
});
afterAll(h.close);

const req = () => h.request(h.app);
const intentar = (email, password) => req().post('/api/auth/login').send({ email, password });

test('la lista de usuarios exige sesión y solo el admin ve correos', async () => {
  expect((await req().get('/api/auth/users')).status).toBe(401);
  const user = await h.login('user');
  const comoUser = await req().get('/api/auth/users').set(h.auth(user.token));
  expect(comoUser.status).toBe(200);
  expect(comoUser.body.data[0].email).toBeUndefined();
  const comoAdmin = await req().get('/api/auth/users').set(h.auth(admin.token));
  expect(comoAdmin.body.data[0].email).toBeDefined();
});

test('nadie puede registrarse sin ser administrador', async () => {
  const datos = { name: 'Intruso', email: 'intruso@prueba.mx', password: 'Intruso-1234' };
  expect((await req().post('/api/auth/register').send(datos)).status).toBe(401);
  const user = await h.login('user');
  expect((await req().post('/api/auth/register').set(h.auth(user.token)).send(datos)).status).toBe(403);
  expect(await Usuario.countDocuments({ email: 'intruso@prueba.mx' })).toBe(0);
});

test('un administrador crea un usuario que puede iniciar sesión (sin recibir su token)', async () => {
  const r = await req().post('/api/auth/register').set(h.auth(admin.token))
    .send({ name: 'Asistente', email: 'Asistente.Nueva@Prueba.mx', password: 'Asistente-123' });
  expect(r.status).toBe(201);
  expect(r.body.token).toBeUndefined();
  expect(r.body.data).toMatchObject({ email: 'asistente.nueva@prueba.mx', role: 'user' });
  expect((await intentar('asistente.nueva@prueba.mx', 'Asistente-123')).status).toBe(200);
  const corta = await req().post('/api/auth/register').set(h.auth(admin.token))
    .send({ name: 'X', email: 'x@prueba.mx', password: '123' });
  expect(corta.status).toBe(400);
});

test('5 intentos fallidos bloquean la cuenta 15 minutos, aun con la contraseña correcta', async () => {
  await Usuario.create({ name: 'Bloqueo', email: 'bloqueo@prueba.mx', password: 'Correcta-123' });
  for (let i = 0; i < 5; i++) expect((await intentar('bloqueo@prueba.mx', 'mala')).status).toBe(401);
  const r = await intentar('bloqueo@prueba.mx', 'Correcta-123');
  expect(r.status).toBe(429);
  expect(r.body.message).toMatch(/bloqueada/);
  // Pasado el bloqueo, entra y el contador se reinicia
  await Usuario.updateOne({ email: 'bloqueo@prueba.mx' }, { $set: { lockUntil: new Date(Date.now() - 1000) } });
  expect((await intentar('bloqueo@prueba.mx', 'Correcta-123')).status).toBe(200);
  const u = await Usuario.findOne({ email: 'bloqueo@prueba.mx' }).lean();
  expect(u.failedLoginAttempts).toBe(0);
});

test('cambiar la contraseña exige la actual y cierra las sesiones anteriores', async () => {
  await Usuario.create({ name: 'Cambio', email: 'cambio@prueba.mx', password: 'Vieja-12345' });
  const vieja = (await intentar('cambio@prueba.mx', 'Vieja-12345')).body.token;
  expect((await req().put('/api/auth/password').set(h.auth(vieja)).send({ currentPassword: 'otra', newPassword: 'Nueva-12345' })).status).toBe(400);
  await new Promise(r => setTimeout(r, 1100)); // el token nuevo debe emitirse en un segundo posterior
  const r = await req().put('/api/auth/password').set(h.auth(vieja)).send({ currentPassword: 'Vieja-12345', newPassword: 'Nueva-12345' });
  expect(r.status).toBe(200);
  expect((await req().get('/api/productos').set(h.auth(vieja))).status).toBe(401);
  expect((await req().get('/api/productos').set(h.auth(r.body.token))).status).toBe(200);
  expect((await intentar('cambio@prueba.mx', 'Vieja-12345')).status).toBe(401);
  expect((await intentar('cambio@prueba.mx', 'Nueva-12345')).status).toBe(200);
});

test('un administrador asigna contraseña nueva y desbloquea', async () => {
  const u = await Usuario.create({ name: 'Olvido', email: 'olvido@prueba.mx', password: 'Olvidada-123', lockUntil: new Date(Date.now() + 600000) });
  const user = await h.login('user');
  expect((await req().put(`/api/auth/users/${u._id}/password`).set(h.auth(user.token)).send({ newPassword: 'Nueva-12345' })).status).toBe(403);
  expect((await req().put(`/api/auth/users/${u._id}/password`).set(h.auth(admin.token)).send({ newPassword: 'Nueva-12345' })).status).toBe(200);
  expect((await intentar('olvido@prueba.mx', 'Nueva-12345')).status).toBe(200);
});

test('CORS: solo la app del ERP y localhost reciben permiso del navegador', async () => {
  const permitido = await req().get('/api/health').set('Origin', 'https://erp-estetica-canina-vercel-xll6.vercel.app');
  expect(permitido.headers['access-control-allow-origin']).toBe('https://erp-estetica-canina-vercel-xll6.vercel.app');
  const local = await req().get('/api/health').set('Origin', 'http://localhost:3055');
  expect(local.headers['access-control-allow-origin']).toBe('http://localhost:3055');
  const ajeno = await req().get('/api/health').set('Origin', 'https://sitio-malicioso.com');
  expect(ajeno.headers['access-control-allow-origin']).toBeUndefined();
  expect(permitido.headers['x-content-type-options']).toBe('nosniff');
});

test('los endpoints temporales de auditoría ya no existen', async () => {
  const r = await req().get('/api/reports/audit-info').set(h.auth(admin.token));
  expect(r.status).toBe(404);
});

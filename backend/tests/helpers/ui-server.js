// Arranca el backend contra la COPIA de pruebas (127.0.0.1:27018/estetica-canica-test)
// para probar la interfaz. Nunca contra Atlas: si la URI no es la local de pruebas, aborta.
// Las variables se fijan antes de que server.js cargue backend/.env, y dotenv no las sobrescribe.
const path = require('path');
const dotenv = require('dotenv');

const backend = path.join(__dirname, '..', '..');
const env = dotenv.parse(require('fs').readFileSync(path.join(backend, '.env.test.local')));

// UI_DB permite usar otra base local de pruebas (debe terminar en -test), p. ej. el ensayo de despliegue.
const base = process.env.UI_DB || 'estetica-canica-test';
if (!/-test$/.test(base)) throw new Error('ui-server: la base debe terminar en -test');
const uri = env.MONGODB_URI.replace(/\/[^/?]+\?/, `/${base}?`);
if (!/^mongodb:\/\/127\.0\.0\.1:27018\/[\w-]+-test\?/.test(uri)) {
  throw new Error('ui-server: la URI no es la copia local de pruebas; abortando.');
}

process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = env.JWT_SECRET;
process.env.NODE_ENV = 'development';
process.env.PORT = process.env.UI_BACKEND_PORT || '5055';

const app = require(path.join(backend, 'server.js'));
app.listen(process.env.PORT, () => console.log(`Backend de pruebas UI en puerto ${process.env.PORT} -> ${base}`));

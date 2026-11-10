// Configura el entorno de pruebas y ABORTA si la base no es la local de pruebas.
// Se carga antes que server.js, así que dotenv de server.js no puede pisar estos valores.
const path = require('path');
const dotenv = require('dotenv');

const parsed = dotenv.config({ path: path.join(__dirname, '..', '..', '.env.test.local'), override: true }).parsed || {};

const JEST_DB = 'erp-jest-test';
const base = parsed.MONGODB_URI || '';
// Reutiliza la instancia local de .env.test.local pero en una base exclusiva para jest
// (estetica-canica-test se conserva intacta como copia de producción).
const uri = base.replace(/\/[^/?]+\?/, `/${JEST_DB}?`);

const SAFE = /^mongodb:\/\/127\.0\.0\.1:27018\/[A-Za-z0-9_-]+-test\?/;
if (!SAFE.test(uri) || !uri.includes(`/${JEST_DB}?`)) {
  throw new Error(`[GUARDIA] URI de pruebas inválida. Solo se permite 127.0.0.1:27018/${JEST_DB}. Abortando.`);
}

process.env.MONGODB_URI = uri;
process.env.JWT_SECRET = parsed.JWT_SECRET || 'jest-secret-local';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  // Se ejecuta ANTES de cargar cualquier módulo de la app: fija la base de pruebas y la valida.
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  testTimeout: 30000,
  // Las pruebas comparten una sola base local: nunca en paralelo.
  maxWorkers: 1
};

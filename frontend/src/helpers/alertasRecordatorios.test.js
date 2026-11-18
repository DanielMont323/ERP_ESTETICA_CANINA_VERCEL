// Pruebas de la lógica de alertas con reloj simulado y audio falso (jsdom no tiene AudioContext).
let osciladores = 0;
class AudioContextFalso {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createOscillator() {
    osciladores += 1;
    return { type: '', frequency: {}, connect: (g) => g, start() {}, stop() {} };
  }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (d) => d };
  }
}

const MIN = 60000;
let A;
beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  window.localStorage.clear();
  window.AudioContext = AudioContextFalso;
  osciladores = 0;
  A = require('./alertasRecordatorios');
});
afterEach(() => jest.useRealTimers());

describe('estadoActual (día de Tepic)', () => {
  test('ayer → retrasado, hoy → hoy, mañana → pendiente, completado → completado', () => {
    const hoy = '2026-11-17';
    expect(A.estadoActual({ fecha: '2026-11-16T00:00:00.000Z', status: 'pendiente' }, hoy)).toBe('retrasado');
    expect(A.estadoActual({ fecha: '2026-11-17T00:00:00.000Z', status: 'pendiente' }, hoy)).toBe('hoy');
    expect(A.estadoActual({ fecha: '2026-11-17T12:00:00.000Z', status: 'pendiente' }, hoy)).toBe('hoy');
    expect(A.estadoActual({ fecha: '2026-11-18T00:00:00.000Z', status: 'pendiente' }, hoy)).toBe('pendiente');
    expect(A.estadoActual({ fecha: '2026-11-16T00:00:00.000Z', status: 'completado' }, hoy)).toBe('completado');
  });
});

describe('debeSonar', () => {
  const base = { ahoraMs: 1000 * MIN, intervaloMs: 15 * MIN };
  test('2: hay recordatorios de hoy y nunca ha sonado → suena', () => {
    expect(A.debeSonar({ ...base, cantidadHoy: 1, ultimaMs: 0 })).toBe(true);
  });
  test('3: vuelve a sonar al cumplirse el intervalo, no antes', () => {
    expect(A.debeSonar({ ...base, cantidadHoy: 2, ultimaMs: base.ahoraMs - 14 * MIN })).toBe(false);
    expect(A.debeSonar({ ...base, cantidadHoy: 2, ultimaMs: base.ahoraMs - 15 * MIN })).toBe(true);
  });
  test('4 y 9: sin recordatorios de hoy (completados o solo futuros) no suena', () => {
    expect(A.debeSonar({ ...base, cantidadHoy: 0, ultimaMs: 0 })).toBe(false);
  });
  test('intervalo 0 = desactivada', () => {
    expect(A.debeSonar({ ...base, intervaloMs: 0, cantidadHoy: 3, ultimaMs: 0 })).toBe(false);
  });
});

describe('intentarAlerta con reloj simulado', () => {
  test('sin interacción del usuario no suena, pero respeta el intervalo; tras activar, suena', async () => {
    const t0 = Date.now();
    expect(A.intentarAlerta(1, t0)).toEqual({ sono: false }); // audio bloqueado por el navegador
    expect(A.intentarAlerta(1, t0 + 5 * MIN)).toBeNull(); // el aviso tampoco se repite antes de tiempo
    await A.desbloquearSonido();
    expect(A.sonidoPermitido()).toBe(true);
    expect(A.intentarAlerta(1, t0 + 15 * MIN)).toEqual({ sono: true });
  });

  test('3 y 10: 3 recordatorios de hoy = UN sonido por ciclo; se repite cada 15 min; nunca dos a la vez', async () => {
    await A.desbloquearSonido();
    const t0 = Date.now();
    expect(A.intentarAlerta(3, t0)).toEqual({ sono: true });
    const porSonido = osciladores;
    expect(porSonido).toBe(6); // 3 pares de tonos
    // Revisiones cada 30 s durante 14.5 min: ningún sonido extra
    for (let s = 30; s < 15 * 60; s += 30) expect(A.intentarAlerta(3, t0 + s * 1000)).toBeNull();
    expect(osciladores).toBe(porSonido);
    jest.advanceTimersByTime(3000);
    expect(A.intentarAlerta(3, t0 + 15 * MIN)).toEqual({ sono: true });
    expect(osciladores).toBe(porSonido * 2);
    // Una reproducción directa mientras suena no se encima
    expect(A.reproducirAlerta()).toBe(false);
  });

  test('10: dos pestañas abiertas comparten la marca → solo una suena', async () => {
    await A.desbloquearSonido();
    const t0 = Date.now();
    expect(A.intentarAlerta(1, t0)).toEqual({ sono: true });
    jest.advanceTimersByTime(3000);
    // "Otra pestaña": módulo nuevo, mismo localStorage
    jest.resetModules();
    const otra = require('./alertasRecordatorios');
    await otra.desbloquearSonido();
    expect(otra.intentarAlerta(1, t0 + 60 * 1000)).toBeNull();
  });

  test('el intervalo se configura y se guarda', () => {
    expect(A.intervaloMin()).toBe(15);
    A.guardarIntervaloMin(5);
    expect(A.intervaloMin()).toBe(5);
    A.guardarIntervaloMin(0);
    expect(A.intervaloMin()).toBe(0);
  });
});

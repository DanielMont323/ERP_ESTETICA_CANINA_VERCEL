// Alertas sonoras de los recordatorios DEL DÍA (Tepic).
//
// Reglas:
// - Solo suenan los recordatorios pendientes cuyo día es HOY. Los futuros no se adelantan y los
//   retrasados se ven en rojo pero no suenan.
// - Un solo sonido por ciclo aunque haya varios recordatorios, y nunca dos a la vez.
// - Se repite cada N minutos (configurable en Configuración → Notificaciones; 15 por defecto)
//   mientras quede alguno sin completar. Al completarlos deja de sonar.
// - Si hay varias pestañas abiertas, suena solo una (marca compartida en localStorage).
// - Los navegadores bloquean el audio hasta que el usuario interactúa con la página: el primer
//   clic o tecla lo activa, y mientras tanto la campana muestra el botón "Activar sonido".
import { hoyTepicISO } from './dateUtils';

export const INTERVALO_DEFECTO_MIN = 15;
export const OPCIONES_INTERVALO = [5, 10, 15, 30, 60];
const CLAVE_INTERVALO = 'erp.alertas.intervaloMin';
const CLAVE_ULTIMA = 'erp.alertas.ultimaVez';
export const EVENTO_CAMBIO = 'recordatorios:cambio';
export const EVENTO_CONFIG = 'recordatorios:config';

const leer = (k) => { try { return window.localStorage.getItem(k); } catch (e) { return null; } };
const escribir = (k, v) => { try { window.localStorage.setItem(k, String(v)); } catch (e) { /* sin almacenamiento */ } };

/** Minutos entre alertas; 0 = sin sonido. */
export function intervaloMin() {
  const v = leer(CLAVE_INTERVALO);
  if (v === null || v === '') return INTERVALO_DEFECTO_MIN;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : INTERVALO_DEFECTO_MIN;
}
export function guardarIntervaloMin(min) {
  escribir(CLAVE_INTERVALO, min);
  window.dispatchEvent(new Event(EVENTO_CONFIG));
}

/** Avisar a la campana que algo cambió (p. ej. se completó un recordatorio) para que deje de sonar ya. */
export const avisarCambioRecordatorios = () => window.dispatchEvent(new Event(EVENTO_CAMBIO));

/** Día AAAA-MM-DD de una fecha guardada con la convención del sistema (componentes UTC). */
export const diaDe = (fecha) => (fecha ? new Date(fecha).toISOString().slice(0, 10) : null);

/**
 * Estado calculado en el navegador (para que a medianoche cambie sin recargar).
 * @returns 'retrasado' | 'hoy' | 'pendiente' | 'completado'
 */
export function estadoActual(item, hoy = hoyTepicISO()) {
  if (item.status === 'completado' || item.estado === 'completado') return 'completado';
  const dia = item.dia || diaDe(item.fecha);
  if (dia < hoy) return 'retrasado';
  if (dia === hoy) return 'hoy';
  return 'pendiente';
}

/** ¿Toca sonar ahora? (función pura, se prueba con reloj simulado) */
export function debeSonar({ cantidadHoy, ahoraMs, ultimaMs, intervaloMs }) {
  if (!cantidadHoy || !intervaloMs) return false;
  if (!ultimaMs) return true;
  return ahoraMs - ultimaMs >= intervaloMs;
}

export const ultimaAlertaMs = () => Number(leer(CLAVE_ULTIMA)) || 0;
export const marcarAlerta = (ms) => escribir(CLAVE_ULTIMA, ms);

// ---------------- Audio ----------------
let contexto = null;
let sonando = false;

function obtenerContexto() {
  if (contexto) return contexto;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  contexto = new Ctx();
  return contexto;
}

/** true si el navegador ya permite reproducir sonido. */
export const sonidoPermitido = () => !!contexto && contexto.state === 'running';

/** Llamar dentro de un clic/tecla del usuario. */
export async function desbloquearSonido() {
  const ctx = obtenerContexto();
  if (!ctx) return false;
  try { if (ctx.state !== 'running') await ctx.resume(); } catch (e) { return false; }
  return ctx.state === 'running';
}

/**
 * Tres pares de tonos (~2 s). Devuelve false si no se pudo (audio bloqueado o ya sonando).
 * Nunca se encima con otra reproducción.
 */
export function reproducirAlerta() {
  const ctx = obtenerContexto();
  if (!ctx || ctx.state !== 'running' || sonando) return false;
  sonando = true;
  const t0 = ctx.currentTime + 0.05;
  const tono = (frecuencia, inicio, duracion) => {
    const osc = ctx.createOscillator();
    const gan = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = frecuencia;
    gan.gain.setValueAtTime(0.0001, inicio);
    gan.gain.exponentialRampToValueAtTime(0.25, inicio + 0.02);
    gan.gain.exponentialRampToValueAtTime(0.0001, inicio + duracion);
    osc.connect(gan).connect(ctx.destination);
    osc.start(inicio);
    osc.stop(inicio + duracion + 0.02);
  };
  for (let i = 0; i < 3; i += 1) {
    tono(880, t0 + i * 0.65, 0.22);
    tono(1320, t0 + i * 0.65 + 0.25, 0.28);
  }
  setTimeout(() => { sonando = false; }, 2200);
  return true;
}

/**
 * Si ya toca (intervalo y marca compartida entre pestañas), dispara la alerta: suena si el
 * navegador lo permite y SIEMPRE marca la hora, para que el aviso visual tampoco se repita antes.
 * @returns null si todavía no toca; { sono } si tocaba
 */
export function intentarAlerta(cantidadHoy, ahoraMs = Date.now()) {
  const intervaloMs = intervaloMin() * 60000;
  if (!debeSonar({ cantidadHoy, ahoraMs, ultimaMs: ultimaAlertaMs(), intervaloMs })) return null;
  marcarAlerta(ahoraMs);
  return { sono: reproducirAlerta() };
}

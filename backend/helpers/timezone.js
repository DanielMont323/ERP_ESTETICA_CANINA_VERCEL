/**
 * Helper para manejar zona horaria GMT-7 (Tepic, Nayarit, México)
 *
 * CONVENCIÓN ÚNICA: las fechas se guardan con la HORA DE TEPIC en los componentes UTC
 * ("reloj de Tepic guardado como UTC"). Una venta a las 18:30 del 11/11 en Tepic se guarda
 * como 2026-11-11T18:30:00Z. Las fechas de calendario (sin hora) van a las 12:00 UTC.
 * Para mostrar se usan los componentes UTC; los rangos de un día son 00:00Z–23:59:59.999Z.
 * Tepic usa UTC-7 todo el año (sin horario de verano desde 2022).
 *
 * Antes de este cambio getCurrentDateGMT7 SUMABA 7 horas (debía restarlas): a partir de las
 * 10:00 de Tepic las ventas quedaban con fecha del día siguiente.
 */
const OFFSET_TEPIC_MS = 7 * 3600000;

/**
 * Obtiene la fecha actual en zona horaria GMT-7
 * @returns {Date} Fecha actual ajustada a GMT-7
 */
const getCurrentDateGMT7 = () => new Date(Date.now() - OFFSET_TEPIC_MS);

/**
 * Convierte una fecha a zona horaria GMT-7
 * @param {Date} date - Fecha a convertir
 * @returns {Date} Fecha ajustada a GMT-7
 */
// Instante real (p. ej. new Date()) → reloj de Tepic guardado como UTC.
const toGMT7 = (date) => {
  if (!date) return null;
  return new Date(new Date(date).getTime() - OFFSET_TEPIC_MS);
};

/**
 * Formatea una fecha en zona horaria GMT-7 para mostrar
 * @param {Date} date - Fecha a formatear
 * @returns {String} Fecha formateada en local (GMT-7)
 */
const formatGMT7 = (date) => {
  if (!date) return '';
  // La fecha ya está en reloj de Tepic: se formatea en UTC para no desplazarla otra vez.
  return new Date(date).toLocaleString('es-MX', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

/**
 * Obtiene el inicio del día en GMT-7
 * @param {Date} date - Fecha de referencia
 * @returns {Date} Inicio del día en GMT-7 (00:00:00)
 */
// Recibe un INSTANTE REAL; devuelve el inicio de ese día de Tepic (00:00Z en la convención).
const startOfDayGMT7 = (date) => {
  const gmt7 = toGMT7(date || new Date());
  gmt7.setUTCHours(0, 0, 0, 0);
  return gmt7;
};

/**
 * Obtiene el fin del día en GMT-7
 * @param {Date} date - Fecha de referencia
 * @returns {Date} Fin del día en GMT-7 (23:59:59.999)
 */
const endOfDayGMT7 = (date) => {
  const gmt7 = toGMT7(date || new Date());
  gmt7.setUTCHours(23, 59, 59, 999);
  return gmt7;
};

/**
 * ============================================================
 * FUNCIONES PARA FECHAS DE CALENDARIO (NO DEPENDEN DE TIMEZONE)
 * ============================================================
 */

/**
 * Crea una fecha de calendario a partir de un string YYYY-MM-DD
 * Usa hora 12:00 UTC para evitar problemas de cambio de día con timezone
 * @param {String} dateStr - Fecha en formato YYYY-MM-DD
 * @returns {Date} Fecha en UTC con hora 12:00:00
 */
const createCalendarDate = (dateStr) => {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  // Crear fecha a las 12:00 UTC (mediodía) para evitar cambio de día con timezone
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
};

/**
 * Formatea una fecha de calendario sin depender de timezone
 * Usa componentes UTC para evitar desfase
 * @param {Date} date - Fecha a formatear
 * @returns {String} Fecha en formato DD/MM/YYYY
 */
const formatCalendarDate = (date) => {
  if (!date) return '';
  const d = new Date(date);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
};

/**
 * Parsea una fecha de calendario desde un string YYYY-MM-DD
 * Alias de createCalendarDate para consistencia
 * @param {String} dateStr - Fecha en formato YYYY-MM-DD
 * @returns {Date} Fecha en UTC con hora 12:00:00
 */
const parseCalendarDate = (dateStr) => {
  return createCalendarDate(dateStr);
};

/**
 * Obtiene el inicio del día GMT-7 a partir de una fecha de calendario
 * @param {Date} calendarDate - Fecha de calendario (UTC 12:00)
 * @returns {Date} Inicio del día en GMT-7 como UTC (07:00 UTC)
 */
const startOfDayGMT7FromCalendar = (calendarDate) => {
  if (!calendarDate) return null;
  const d = new Date(calendarDate);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * Obtiene el fin del día GMT-7 a partir de una fecha de calendario
 * @param {Date} calendarDate - Fecha de calendario (UTC 12:00)
 * @returns {Date} Fin del día en GMT-7 como UTC (06:59 UTC del día siguiente)
 */
const endOfDayGMT7FromCalendar = (calendarDate) => {
  if (!calendarDate) return null;
  const d = new Date(calendarDate);
  d.setUTCHours(23, 59, 59, 999);
  return d;
};

/**
 * Fecha de calendario de HOY en Tepic (America/Mazatlan, UTC-7 todo el año),
 * con la convención de fechas de calendario: 12:00 UTC de ese día.
 * Sustituye a getCurrentDateGMT7 en compras: esa función suma 7 horas en lugar de
 * restarlas, y a partir de las 10:00 de Tepic devuelve el día siguiente.
 * @param {Date} [ahora] - Instante de referencia (para pruebas)
 * @returns {Date}
 */
const hoyCalendarioTepic = (ahora = new Date()) => {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mazatlan', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(ahora);
  return createCalendarDate(ymd);
};

/**
 * Rango { start, end } de un periodo en la convención de Tepic.
 * period: 'day'|'today'|'week' (domingo a sábado)|'month'|'year'; o startDate/endDate 'YYYY-MM-DD'.
 * Devuelve null si no hay periodo ni fechas.
 */
const rangoPeriodoTepic = ({ period, startDate, endDate } = {}, ahora = new Date()) => {
  const hoy = toGMT7(ahora);
  const y = hoy.getUTCFullYear(), m = hoy.getUTCMonth(), d = hoy.getUTCDate();
  const dia = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd));
  const fin = siguiente => new Date(siguiente.getTime() - 1);
  if (period === 'day' || period === 'today') return { start: dia(y, m, d), end: fin(dia(y, m, d + 1)) };
  if (period === 'week') {
    const dom = d - hoy.getUTCDay();
    return { start: dia(y, m, dom), end: fin(dia(y, m, dom + 7)) };
  }
  if (period === 'month') return { start: dia(y, m, 1), end: fin(dia(y, m + 1, 1)) };
  if (period === 'year') return { start: dia(y, 0, 1), end: fin(dia(y + 1, 0, 1)) };
  if (startDate && endDate) {
    return { start: startOfDayGMT7FromCalendar(createCalendarDate(startDate)), end: endOfDayGMT7FromCalendar(createCalendarDate(endDate)) };
  }
  return null;
};

module.exports = {
  getCurrentDateGMT7,
  rangoPeriodoTepic,
  OFFSET_TEPIC_MS,
  hoyCalendarioTepic,
  toGMT7,
  formatGMT7,
  startOfDayGMT7,
  endOfDayGMT7,
  // Funciones para fechas de calendario
  createCalendarDate,
  formatCalendarDate,
  parseCalendarDate,
  startOfDayGMT7FromCalendar,
  endOfDayGMT7FromCalendar
};

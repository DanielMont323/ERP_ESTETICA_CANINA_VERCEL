import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { remindersAPI } from '../services/api';
import { Bell, Calendar, DollarSign, VolumeX } from 'lucide-react';
import { formatCalendarDate, hoyTepicISO } from '../helpers/dateUtils';
import {
  estadoActual, diaDe, intentarAlerta, desbloquearSonido, sonidoPermitido, reproducirAlerta,
  intervaloMin, EVENTO_CAMBIO, EVENTO_CONFIG
} from '../helpers/alertasRecordatorios';

// Campana de recordatorios en el encabezado.
// - El número rojo cuenta los URGENTES: retrasados y de hoy.
// - Los recordatorios de HOY suenan cada N minutos mientras sigan pendientes (ver helpers/alertasRecordatorios).
// - Fuentes: bandeja de recordatorios (manuales + próximas dosis del carnet) y cuentas por pagar.
//   Una cuenta que ya tiene su recordatorio de pago ligado no se repite.
const ORDEN = { retrasado: 0, hoy: 1, pendiente: 2 };
const TEXTO = { retrasado: 'Retrasado', hoy: 'Hoy', pendiente: 'Próximo' };
const REVISAR_CADA_MS = 30 * 1000;
const RECARGAR_CADA_MS = 5 * 60 * 1000;
const ID_TOAST = 'alerta-recordatorios-hoy';
const TITULO_BASE = typeof document !== 'undefined' ? document.title : 'Barber Dog';


const GlobalReminders = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [reminders, setReminders] = useState([]);
  const [abierto, setAbierto] = useState(false);
  const [sonidoOk, setSonidoOk] = useState(sonidoPermitido());
  const [hoy, setHoy] = useState(hoyTepicISO());
  const [intervalo, setIntervalo] = useState(intervaloMin());
  const ref = useRef(null);

  const fetchReminders = useCallback(async () => {
    try {
      const [bandejaRes, dashboardRes] = await Promise.all([
        remindersAPI.getBandeja('pendientes'),
        remindersAPI.getDashboard()
      ]);
      const items = bandejaRes.data.data?.items || [];
      const ligadas = new Set(bandejaRes.data.data?.cuentasConRecordatorio || []);
      const cuentas = (dashboardRes.data.data?.accounts || []).filter(c => !ligadas.has(String(c.id)));
      setReminders([
        ...items.map(i => ({ id: i.id, fuente: i.tipo === 'pago' ? 'cuenta' : i.origen === 'carnet' ? 'vacuna' : 'manual', title: i.titulo, description: i.descripcion, date: i.fecha, dia: i.dia, status: i.status })),
        ...cuentas.map(c => ({ id: `cuenta-${c.id}`, fuente: 'cuenta', title: c.title, description: c.description, date: c.date, dia: diaDe(c.date), status: 'pendiente' }))
      ]);
    } catch (error) {
      console.error('Error loading reminders:', error);
    }
  }, []);

  // Carga, recarga periódica y recarga inmediata cuando otra pantalla avisa un cambio
  useEffect(() => {
    fetchReminders();
    const recarga = setInterval(fetchReminders, RECARGAR_CADA_MS);
    const alCambio = () => fetchReminders();
    const alConfig = () => setIntervalo(intervaloMin());
    window.addEventListener(EVENTO_CAMBIO, alCambio);
    window.addEventListener(EVENTO_CONFIG, alConfig);
    window.addEventListener('focus', alCambio);
    return () => {
      clearInterval(recarga);
      window.removeEventListener(EVENTO_CAMBIO, alCambio);
      window.removeEventListener(EVENTO_CONFIG, alConfig);
      window.removeEventListener('focus', alCambio);
    };
  }, [fetchReminders]);

  // El navegador solo deja sonar después de una interacción: el primer clic o tecla activa el audio
  useEffect(() => {
    if (sonidoOk) return undefined;
    const activar = async () => { if (await desbloquearSonido()) setSonidoOk(true); };
    window.addEventListener('pointerdown', activar);
    window.addEventListener('keydown', activar);
    return () => {
      window.removeEventListener('pointerdown', activar);
      window.removeEventListener('keydown', activar);
    };
  }, [sonidoOk]);

  const conEstado = reminders
    .map(r => ({ ...r, estado: estadoActual(r, hoy) }))
    .filter(r => r.estado !== 'completado');
  const urgentes = conEstado.filter(r => r.estado === 'retrasado' || r.estado === 'hoy')
    .sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado] || new Date(a.date) - new Date(b.date));
  const deHoy = conEstado.filter(r => r.estado === 'hoy');
  const limite = new Date(`${hoy}T00:00:00Z`).getTime() + 7 * 86400000;
  const proximos = conEstado.filter(r => r.estado === 'pendiente' && new Date(`${r.dia}T00:00:00Z`).getTime() <= limite)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // Ciclo de alertas: revisa cada 30 s si toca sonar (el intervalo real lo decide intentarAlerta)
  const deHoyRef = useRef(deHoy);
  deHoyRef.current = deHoy;
  useEffect(() => {
    const revisar = () => {
      const nuevoHoy = hoyTepicISO();
      if (nuevoHoy !== hoy) setHoy(nuevoHoy); // cambió el día: se recalculan los estados
      const lista = deHoyRef.current;
      if (lista.length === 0) { toast.dismiss(ID_TOAST); return; }
      const r = intentarAlerta(lista.length);
      if (!r) return;
      toast(
        (t) => (
          <div className="text-sm">
            <p className="font-semibold">
              🔔 {lista.length === 1 ? 'Tienes 1 recordatorio para hoy' : `Tienes ${lista.length} recordatorios para hoy`}
            </p>
            <ul className="mt-1 list-disc pl-4">
              {lista.slice(0, 3).map(x => <li key={x.id} className="truncate max-w-[16rem]">{x.title}</li>)}
              {lista.length > 3 && <li>y {lista.length - 3} más…</li>}
            </ul>
            <button
              className="mt-2 text-brand-burgundy font-medium underline"
              onClick={() => { toast.dismiss(t.id); navigate('/reminders'); }}
            >
              Ver recordatorios
            </button>
          </div>
        ),
        { id: ID_TOAST, duration: 15000 }
      );
    };
    revisar();
    const ciclo = setInterval(revisar, REVISAR_CADA_MS);
    return () => clearInterval(ciclo);
  }, [hoy, navigate, deHoy.length, intervalo]);

  // Título de la pestaña: se ve aunque la ventana esté detrás de otra
  useEffect(() => {
    document.title = deHoy.length > 0 ? `(${deHoy.length}) Recordatorios de hoy · ${TITULO_BASE}` : TITULO_BASE;
    return () => { document.title = TITULO_BASE; };
  }, [deHoy.length]);

  // Al cambiar de pantalla se cierra el panel
  useEffect(() => { setAbierto(false); }, [location.pathname]);

  // Cerrar al hacer clic fuera
  useEffect(() => {
    if (!abierto) return undefined;
    const cerrar = e => { if (ref.current && !ref.current.contains(e.target)) setAbierto(false); };
    document.addEventListener('mousedown', cerrar);
    return () => document.removeEventListener('mousedown', cerrar);
  }, [abierto]);

  const activarSonido = async (e) => {
    e.stopPropagation();
    if (await desbloquearSonido()) {
      setSonidoOk(true);
      reproducirAlerta(); // confirma que ya suena
      toast.success('Sonido de alertas activado');
    } else {
      toast.error('El navegador no permitió activar el sonido');
    }
  };

  const color = estado => (estado === 'retrasado'
    ? 'text-danger-600 bg-danger-50'
    : estado === 'hoy' ? 'text-warning-700 bg-warning-50' : 'text-gray-600 bg-gray-100 dark:bg-dark-surface dark:text-dark-textSecondary');

  const Fila = ({ r }) => {
    const Icon = r.fuente === 'cuenta' ? DollarSign : r.fuente === 'vacuna' ? Calendar : Bell;
    return (
      <div className="flex items-start gap-3 px-4 py-2.5 border-b border-gray-100 dark:border-dark-border last:border-0">
        <div className={`p-1.5 rounded-lg ${color(r.estado)}`}><Icon className="h-4 w-4" /></div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-dark-text truncate" title={r.title}>{r.title}</p>
          {r.description && <p className="text-xs text-gray-500 dark:text-dark-textSecondary truncate" title={r.description}>{r.description}</p>}
          <p className="text-xs text-gray-500 dark:text-dark-textSecondary mt-0.5">
            {formatCalendarDate(r.date)}
            <span className={`ml-2 px-1.5 py-0.5 rounded-full ${color(r.estado)}`}>{TEXTO[r.estado]}</span>
          </p>
        </div>
      </div>
    );
  };

  const mostrarActivar = !sonidoOk && intervalo > 0 && deHoy.length > 0;

  return (
    <div className="relative flex items-center gap-1" ref={ref}>
      {mostrarActivar && (
        <button
          onClick={activarSonido}
          className="hidden sm:inline-flex items-center gap-1 text-xs font-medium text-warning-700 bg-warning-50 border border-warning-200 rounded-lg px-2 py-1"
          title="El navegador bloquea el sonido hasta que se active"
        >
          <VolumeX className="h-3.5 w-3.5" /> Activar sonido
        </button>
      )}
      <button
        onClick={(e) => { if (mostrarActivar) activarSonido(e); setAbierto(!abierto); }}
        className={`btn-ghost p-2 rounded-lg relative ${deHoy.length > 0 ? 'animate-pulse' : ''}`}
        title="Recordatorios"
        aria-label={`Recordatorios: ${urgentes.length} urgentes`}
      >
        <Bell className="h-5 w-5" />
        {urgentes.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-danger-600 text-white text-[0.65rem] font-bold flex items-center justify-center">
            {urgentes.length > 99 ? '99+' : urgentes.length}
          </span>
        )}
      </button>

      {abierto && (
        <div className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-dark-card rounded-xl shadow-xl border border-gray-200 dark:border-dark-border z-40">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-dark-border">
            <p className="font-semibold text-gray-900 dark:text-dark-text">Recordatorios</p>
            <p className="text-xs text-gray-500 dark:text-dark-textSecondary">
              {urgentes.filter(r => r.estado === 'retrasado').length} retrasados · {deHoy.length} para hoy · {proximos.length} próximos
            </p>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {urgentes.length === 0 && proximos.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-gray-500">No hay recordatorios pendientes</p>
            )}
            {urgentes.length > 0 && (
              <>
                <p className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-danger-600">Urgentes</p>
                {urgentes.slice(0, 8).map(r => <Fila key={r.id} r={r} />)}
                {urgentes.length > 8 && <p className="px-4 py-1 text-xs text-gray-500">y {urgentes.length - 8} más…</p>}
              </>
            )}
            {proximos.length > 0 && (
              <>
                <p className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Próximos 7 días</p>
                {proximos.slice(0, 5).map(r => <Fila key={r.id} r={r} />)}
              </>
            )}
          </div>
          <div className="p-2 border-t border-gray-200 dark:border-dark-border">
            <button
              onClick={() => { setAbierto(false); navigate('/reminders'); }}
              className="w-full text-center text-sm text-brand-burgundy font-medium py-2 rounded-lg hover:bg-brand-cream transition-colors"
            >
              Ver todos los recordatorios
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GlobalReminders;

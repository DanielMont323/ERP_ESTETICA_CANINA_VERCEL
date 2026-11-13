import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { remindersAPI } from '../services/api';
import { Bell, Calendar, DollarSign } from 'lucide-react';
import { formatCalendarDate } from '../helpers/dateUtils';

// Campana de recordatorios en el encabezado. Antes era un cuadro flotante fijo que tapaba el
// encabezado y mostraba un total de 90 sin distinguir lo urgente. Ahora:
// - la campana muestra solo cuántos son URGENTES (vencidos, de hoy o prioridad alta);
// - al abrirla se listan primero los urgentes y luego los próximos.
const URGENTES = ['vencida', 'hoy', 'alta'];
const ORDEN = { vencida: 0, hoy: 1, alta: 1, manana: 2, media: 2, proxima: 3, baja: 3 };

const GlobalReminders = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [reminders, setReminders] = useState([]);
  const [abierto, setAbierto] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const fetchReminders = async () => {
      try {
        const [upcomingRes, dashboardRes] = await Promise.all([
          remindersAPI.getUpcoming(),
          remindersAPI.getDashboard()
        ]);
        const manuales = upcomingRes.data.data || [];
        const panel = dashboardRes.data.data || {};
        const todos = [
          ...manuales.map(r => ({ id: r._id, type: 'manual', title: r.title, description: r.description || '', date: r.date, urgency: r.priority === 'alta' ? 'alta' : 'media' })),
          ...(panel.accounts || []).map(r => ({ id: r.id, type: 'cuenta', title: r.title, description: r.description, date: r.date, urgency: r.urgency })),
          ...(panel.vaccines || []).map(r => ({ id: r.id, type: 'vacuna', title: r.title, description: r.description, date: r.date, urgency: r.urgency }))
        ];
        todos.sort((a, b) => (ORDEN[a.urgency] ?? 9) - (ORDEN[b.urgency] ?? 9) || new Date(a.date) - new Date(b.date));
        setReminders(todos);
      } catch (error) {
        console.error('Error loading reminders:', error);
      }
    };
    fetchReminders();
    const cada5Min = setInterval(fetchReminders, 5 * 60 * 1000);
    return () => clearInterval(cada5Min);
  }, []);

  // Al cambiar de pantalla se cierra el panel
  useEffect(() => { setAbierto(false); }, [location.pathname]);

  // Cerrar al hacer clic fuera
  useEffect(() => {
    if (!abierto) return undefined;
    const cerrar = e => { if (ref.current && !ref.current.contains(e.target)) setAbierto(false); };
    document.addEventListener('mousedown', cerrar);
    return () => document.removeEventListener('mousedown', cerrar);
  }, [abierto]);

  const urgentes = reminders.filter(r => URGENTES.includes(r.urgency));
  const proximos = reminders.filter(r => !URGENTES.includes(r.urgency));

  const color = urgency => (URGENTES.includes(urgency)
    ? 'text-danger-600 bg-danger-50'
    : urgency === 'manana' || urgency === 'media' ? 'text-warning-600 bg-warning-50' : 'text-success-600 bg-success-50');
  const texto = { vencida: 'Vencida', hoy: 'Hoy', manana: 'Mañana', proxima: 'Próxima', alta: 'Alta', media: 'Media', baja: 'Baja' };

  const Fila = ({ r }) => {
    const Icon = r.type === 'cuenta' ? DollarSign : r.type === 'vacuna' ? Calendar : Bell;
    return (
      <div className="flex items-start gap-3 px-4 py-2.5 border-b border-gray-100 dark:border-dark-border last:border-0">
        <div className={`p-1.5 rounded-lg ${color(r.urgency)}`}><Icon className="h-4 w-4" /></div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-dark-text truncate" title={r.title}>{r.title}</p>
          {r.description && <p className="text-xs text-gray-500 dark:text-dark-textSecondary truncate" title={r.description}>{r.description}</p>}
          <p className="text-xs text-gray-500 dark:text-dark-textSecondary mt-0.5">
            {formatCalendarDate(r.date)}
            <span className={`ml-2 px-1.5 py-0.5 rounded-full ${color(r.urgency)}`}>{texto[r.urgency] || ''}</span>
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setAbierto(!abierto)}
        className="btn-ghost p-2 rounded-lg relative"
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
              {urgentes.length} urgentes · {proximos.length} próximos
            </p>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {reminders.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-gray-500">No hay recordatorios pendientes</p>
            )}
            {urgentes.length > 0 && (
              <>
                <p className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-danger-600">Urgentes</p>
                {urgentes.slice(0, 8).map(r => <Fila key={`${r.type}-${r.id}`} r={r} />)}
              </>
            )}
            {proximos.length > 0 && (
              <>
                <p className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Próximos</p>
                {proximos.slice(0, 5).map(r => <Fila key={`${r.type}-${r.id}`} r={r} />)}
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

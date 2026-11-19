import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { X, Syringe, ShoppingCart, CheckCircle, CalendarClock } from 'lucide-react';
import { remindersAPI } from '../services/api';
import { hoyTepicISO, formatCalendarDate } from '../helpers/dateUtils';

// Al completar el recordatorio de una vacuna o desparasitación del carnet se pregunta qué pasó:
//  - Se cobra ahora → Ventas (la venta la registra en el carnet y descuenta inventario).
//  - Ya se aplicó aquí → se registra la nueva aplicación en el carnet (sin tocar inventario).
//  - Reagendar: cambia la fecha del recordatorio (queda en el historial; la próxima dosis original no se toca).
//  - Solo cerrar el recordatorio (no se aplicó aquí, el dueño no quiso, etc.).
const CompletarDosisModal = ({ item, onClose, onListo, pasoInicial = 'elegir' }) => {
  const navigate = useNavigate();
  const [paso, setPaso] = useState(pasoInicial);
  const [nuevaFecha, setNuevaFecha] = useState('');
  const [nota, setNota] = useState('');
  const [fecha, setFecha] = useState(hoyTepicISO());
  const [dias, setDias] = useState(item.diasSugeridos ? String(item.diasSugeridos) : '');
  const [observaciones, setObservaciones] = useState('');
  const [guardando, setGuardando] = useState(false);
  const esDesp = item.tipo === 'desparasitante';
  const nombre = item.titulo.replace(/^(Vacuna|Desparasitación):\s*/, '');

  useEffect(() => {
    const esc = e => { if (e.key === 'Escape' && !guardando) onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose, guardando]);

  const proxima = (() => {
    const n = parseInt(dias, 10);
    if (!fecha || !Number.isInteger(n) || n <= 0) return null;
    return new Date(new Date(`${fecha}T12:00:00Z`).getTime() + n * 86400000);
  })();

  const registrar = async () => {
    setGuardando(true);
    try {
      await remindersAPI.aplicarCarnet(item.carnetId, item.aplicacionId, {
        fecha, diasProximaDosis: dias === '' ? null : parseInt(dias, 10), observaciones
      });
      toast.success(proxima
        ? `Registrada en el carnet. Próxima dosis: ${formatCalendarDate(proxima)}`
        : 'Registrada en el carnet');
      onListo();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo registrar la aplicación');
      setGuardando(false);
    }
  };

  const reagendar = async () => {
    setGuardando(true);
    try {
      await remindersAPI.reagendarCarnet(item.carnetId, item.aplicacionId, { fecha: nuevaFecha, nota });
      toast.success(`Recordatorio reagendado para el ${formatCalendarDate(`${nuevaFecha}T12:00:00Z`)}`);
      onListo();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo reagendar');
      setGuardando(false);
    }
  };

  const soloCerrar = async () => {
    setGuardando(true);
    try {
      await remindersAPI.atenderCarnet(item.carnetId, item.aplicacionId);
      toast.success('Recordatorio cerrado. Lo encuentras en "Completados".');
      onListo();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo cerrar el recordatorio');
      setGuardando(false);
    }
  };

  const Opcion = ({ icono: Icono, titulo, ayuda, onClick }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={guardando}
      className="w-full text-left rounded-lg border border-gray-200 dark:border-dark-border p-3 hover:border-brand-burgundy hover:bg-red-50 dark:hover:bg-transparent transition flex gap-3"
    >
      <Icono className="h-5 w-5 text-brand-burgundy shrink-0 mt-0.5" />
      <span>
        <span className="block font-medium text-gray-900 dark:text-dark-text">{titulo}</span>
        <span className="block text-xs text-gray-500 dark:text-dark-textSecondary">{ayuda}</span>
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Completar recordatorio">
      <div className="flex items-center justify-center min-h-screen px-4 py-6">
        <div className="modal-overlay" onClick={() => !guardando && onClose()} />
        <div className="relative modal-content max-w-md w-full p-6 animate-slide-up space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-gray-800 dark:text-dark-text">{item.titulo}</h3>
              <p className="text-sm text-gray-500 dark:text-dark-textSecondary">{item.descripcion}</p>
            </div>
            <button onClick={onClose} disabled={guardando} className="text-gray-400 hover:text-gray-600" aria-label="Cerrar"><X className="h-5 w-5" /></button>
          </div>

          {paso === 'elegir' && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700 dark:text-dark-textSecondary">¿Se aplicó {esDesp ? 'la desparasitación' : 'la vacuna'}?</p>
              <Opcion
                icono={ShoppingCart}
                titulo="Se va a cobrar ahora"
                ayuda="Abre una venta nueva con el cliente y la mascota (y el producto, si se vendió antes). Al cobrarla se registra en el carnet, se descuenta del inventario y este recordatorio se cierra."
                onClick={() => {
                  onClose();
                  if (!item.dueno?.id || !item.mascota?.id) { navigate('/sales'); return; }
                  const q = new URLSearchParams({
                    desde: 'recordatorio',
                    cliente: item.dueno.id,
                    mascota: item.mascota.id,
                    carnet: item.carnetId,
                    aplicacion: item.aplicacionId,
                    titulo: item.titulo
                  });
                  if (item.productoId) q.set('producto', item.productoId);
                  if (item.diasSugeridos) q.set('dias', String(item.diasSugeridos));
                  navigate(`/sales?${q.toString()}`);
                }}
              />
              <Opcion
                icono={Syringe}
                titulo="Sí, ya se aplicó aquí"
                ayuda="Registrarla en el carnet (por ejemplo, si ya se cobró o no se cobra). No mueve el inventario."
                onClick={() => setPaso('registrar')}
              />
              <Opcion
                icono={CalendarClock}
                titulo="Reagendar"
                ayuda="Todavía no se aplica: cambiar la fecha del recordatorio (por ejemplo, el dueño pidió otro día). Sigue pendiente."
                onClick={() => setPaso('reagendar')}
              />
              <Opcion
                icono={CheckCircle}
                titulo="Solo cerrar el recordatorio"
                ayuda="No se aplicó aquí: el dueño no quiso, se aplicó en otro lugar o la mascota ya no viene."
                onClick={soloCerrar}
              />
            </div>
          )}

          {paso === 'reagendar' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-700 dark:text-dark-textSecondary">
                Fecha actual del recordatorio: <strong>{formatCalendarDate(item.fecha)}</strong>
              </p>
              <div>
                <label className="form-label" htmlFor="nueva-fecha">Nueva fecha</label>
                <input id="nueva-fecha" type="date" className="form-input" value={nuevaFecha} min={hoyTepicISO()} onChange={e => setNuevaFecha(e.target.value)} />
              </div>
              <div>
                <label className="form-label" htmlFor="nota-reagendar">Motivo (opcional)</label>
                <input id="nota-reagendar" className="form-input" value={nota} maxLength={300} onChange={e => setNota(e.target.value)} placeholder="Ej. el dueño pidió el sábado" />
              </div>
              <p className="text-xs text-gray-500 dark:text-dark-textSecondary">El recordatorio sigue pendiente con la nueva fecha. La fecha original queda en el historial.</p>
              <div className="flex justify-end gap-2 pt-1">
                {pasoInicial === 'elegir' && (
                  <button type="button" onClick={() => setPaso('elegir')} disabled={guardando} className="btn btn-secondary btn-md">Atrás</button>
                )}
                <button type="button" onClick={reagendar} disabled={guardando || !nuevaFecha || nuevaFecha < hoyTepicISO()} className="btn btn-primary btn-md">
                  {guardando ? 'Guardando…' : 'Reagendar'}
                </button>
              </div>
            </div>
          )}

          {paso === 'registrar' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <p className="form-label">Producto</p>
                  <p className="text-sm font-medium text-gray-800 dark:text-dark-text">{nombre} <span className="text-gray-500">({esDesp ? 'desparasitante' : 'vacuna'})</span></p>
                </div>
                <div>
                  <label className="form-label" htmlFor="fecha-aplicacion">Fecha de aplicación</label>
                  <input id="fecha-aplicacion" type="date" className="form-input" value={fecha} max={hoyTepicISO()} onChange={e => setFecha(e.target.value)} />
                </div>
                <div>
                  <label className="form-label" htmlFor="dias-proxima">Próxima dosis en (días)</label>
                  <input id="dias-proxima" type="number" min="0" className="form-input" value={dias} onChange={e => setDias(e.target.value)} placeholder="Sin próxima" />
                </div>
              </div>
              <p className="text-xs text-gray-600 dark:text-dark-textSecondary">
                {proxima ? <>Se creará el recordatorio de la próxima dosis para el <strong>{formatCalendarDate(proxima)}</strong>.</> : 'Sin próxima dosis: no se creará un nuevo recordatorio.'}
              </p>
              <div>
                <label className="form-label" htmlFor="obs-aplicacion">Observaciones (opcional)</label>
                <input id="obs-aplicacion" className="form-input" value={observaciones} onChange={e => setObservaciones(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setPaso('elegir')} disabled={guardando} className="btn btn-secondary btn-md">Atrás</button>
                <button type="button" onClick={registrar} disabled={guardando || !fecha} className="btn btn-primary btn-md">
                  {guardando ? 'Guardando…' : 'Registrar en el carnet'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CompletarDosisModal;

import React, { useState, useEffect, useCallback } from 'react';
import { remindersAPI } from '../services/api';
import { hoyTepicISO, formatCalendarDate } from '../helpers/dateUtils';
import { estadoActual, avisarCambioRecordatorios } from '../helpers/alertasRecordatorios';
import { etiqueta } from '../helpers/etiquetas';
import toast from 'react-hot-toast';
import { alDobleClic, TITULO_DOBLE_CLIC } from '../helpers/dobleClic';
import { Skeleton, SkeletonCard } from '../components/Skeleton';
import ConfirmModal from '../components/ConfirmModal';
import DetallePagoModal from '../components/DetallePagoModal';
import CompletarDosisModal from '../components/CompletarDosisModal';
import {
  Plus,
  Calendar,
  CheckCircle,
  Edit,
  Trash2,
  Search,
  UserCheck,
  Receipt
} from 'lucide-react';

// Para reutilizar el formulario de edición de siempre con un elemento de la bandeja
const aFormulario = (i) => ({ _id: i.recordatorioId, title: i.titulo, description: i.descripcion, type: i.tipo, priority: i.prioridad, date: i.fecha, status: i.status });

const ESTILO_ESTADO = {
  retrasado: { texto: 'Retrasado', badge: 'badge-danger', borde: 'border-l-4 border-l-danger-500' },
  hoy: { texto: 'Hoy', badge: 'badge-warning', borde: 'border-l-4 border-l-warning-500' },
  pendiente: { texto: 'Pendiente', badge: 'badge-info', borde: 'border-l-4 border-l-transparent' },
  completado: { texto: 'Completado', badge: 'badge-gray', borde: 'border-l-4 border-l-transparent opacity-80' }
};
const TIPOS = [
  { id: 'todos', texto: 'Todos los tipos' },
  { id: 'pago', texto: 'Pagos' },
  { id: 'vacunas', texto: 'Vacunas y desparasitantes' },
  { id: 'otros', texto: 'Otros' }
];
const VISTAS = [
  { id: 'pendientes', texto: 'Pendientes' },
  { id: 'completados', texto: 'Completados' },
  { id: 'todos', texto: 'Todos' }
];
// completedAt y los avisos se guardan como instante real → se muestran en hora de Tepic
const fechaHora = (f) => (f ? new Date(f).toLocaleString('es-MX', {
  timeZone: 'America/Mazatlan', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
}) : '');
const textoCompletado = (c) => {
  if (!c) return '';
  if (c.motivo === 'siguiente_dosis_aplicada') return `Se aplicó la siguiente dosis el ${formatCalendarDate(c.fecha)}`;
  if (c.motivo === 'cuenta_pagada') return `Se completó solo al pagar la cuenta${c.fecha ? ` · ${fechaHora(c.fecha)}` : ''}`;
  if (c.motivo === 'cuenta_cancelada') return `Se completó solo al cancelar la cuenta${c.fecha ? ` · ${fechaHora(c.fecha)}` : ''}`;
  return `Completado${c.fecha ? ` el ${fechaHora(c.fecha)}` : ''}${c.nombre ? ` por ${c.nombre}` : ''}`;
};

const Bandeja = ({ items, conteo, vista, setVista, filtroTipo, setFiltroTipo, hoy, onCompletar, onNotificar, onEditar, onVerPago, onEliminar, ocupado }) => (
  <div className="space-y-4">
    <div className="flex flex-col md:flex-row md:items-center gap-3">
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-dark-border overflow-hidden" role="tablist" aria-label="Ver recordatorios">
        {VISTAS.map(v => (
          <button
            key={v.id}
            role="tab"
            aria-selected={vista === v.id}
            onClick={() => setVista(v.id)}
            className={`px-3 py-1.5 text-sm font-medium ${vista === v.id ? 'bg-brand-burgundy text-white' : 'bg-white dark:bg-dark-card text-gray-700 dark:text-dark-textSecondary hover:bg-gray-50'}`}
          >
            {v.texto}
          </button>
        ))}
      </div>
      <select value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)} className="form-input md:w-60" aria-label="Tipo de recordatorio">
        {TIPOS.map(t => <option key={t.id} value={t.id}>{t.texto}</option>)}
      </select>
      {vista !== 'completados' && (
        <p className="text-sm text-gray-600 dark:text-dark-textSecondary md:ml-auto">
          <span className="text-danger-600 font-semibold">{conteo.retrasado} retrasados</span>
          {' · '}<span className="text-warning-700 font-semibold">{conteo.hoy} para hoy</span>
          {' · '}{conteo.pendiente} próximos
        </p>
      )}
    </div>

    {items.length === 0 ? (
      <div className="text-center py-10 text-gray-500 dark:text-dark-textSecondary">
        {vista === 'completados' ? 'No hay recordatorios completados' : 'No hay recordatorios pendientes 🎉'}
      </div>
    ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map(item => {
          const estado = estadoActual(item, hoy);
          const e = ESTILO_ESTADO[estado];
          const manual = item.origen === 'manual';
          const pendiente = estado !== 'completado';
          return (
            <div
              key={item.id}
              className={`card ${e.borde} ${manual ? 'cursor-pointer' : ''}`}
              onDoubleClick={manual ? alDobleClic(() => (item.tipo === 'pago' ? onVerPago(item) : onEditar(item.original))) : undefined}
              title={manual ? (item.tipo === 'pago' ? 'Doble clic para ver la compra y la cuenta por pagar' : TITULO_DOBLE_CLIC) : undefined}
              data-estado={estado}
            >
              <div className="card-body space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-base font-medium text-gray-800 dark:text-dark-text">{item.titulo}</h3>
                  <span className={`badge ${e.badge} shrink-0`}>{e.texto}</span>
                </div>
                {item.descripcion && <p className="text-sm text-gray-600 dark:text-dark-textSecondary">{item.descripcion}</p>}
                {item.dueno?.telefono && pendiente && (
                  <p className="text-sm text-gray-600 dark:text-dark-textSecondary">Tel. dueño: <a className="text-brand-burgundy" href={`tel:${item.dueno.telefono}`}>{item.dueno.telefono}</a></p>
                )}
                <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-dark-textSecondary">
                  <span className="inline-flex items-center">
                    <Calendar className="h-4 w-4 mr-1" />
                    {item.origen === 'carnet' ? 'Próxima dosis: ' : ''}{formatCalendarDate(item.fecha)}
                  </span>
                  <span className="badge badge-gray">{etiqueta(item.tipo)}</span>
                  {manual && item.prioridad && <span className="badge badge-gray">Prioridad {item.prioridad}</span>}
                </div>
                {item.duenoNotificado && (
                  <p className="text-xs inline-flex items-center gap-1 text-success-700 bg-success-50 rounded px-2 py-1">
                    <UserCheck className="h-3.5 w-3.5" />
                    Dueño notificado el {fechaHora(item.duenoNotificado.fecha)}{item.duenoNotificado.nombre ? ` por ${item.duenoNotificado.nombre}` : ''}
                  </p>
                )}
                {!pendiente && <p className="text-xs text-gray-500 dark:text-dark-textSecondary">{textoCompletado(item.completado)}</p>}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {pendiente && (
                    <button onClick={() => onCompletar(item)} disabled={ocupado === item.id} className="btn btn-sm btn-success inline-flex items-center gap-1">
                      <CheckCircle className="h-4 w-4" /> Completar
                    </button>
                  )}
                  {pendiente && item.puedeNotificarDueno && !item.duenoNotificado && (
                    <button onClick={() => onNotificar(item)} disabled={ocupado === item.id} className="btn btn-sm btn-secondary inline-flex items-center gap-1" title="Registra que ya se le avisó al dueño. El recordatorio sigue pendiente.">
                      <UserCheck className="h-4 w-4" /> Dueño notificado
                    </button>
                  )}
                  {manual && (
                    <span className="ml-auto flex items-center gap-2">
                      {item.tipo === 'pago' && (
                        <button onClick={() => onVerPago(item)} className="text-gray-600 hover:text-gray-900" title="Ver compra y cuenta por pagar" aria-label="Ver compra y cuenta por pagar">
                          <Receipt className="h-4 w-4" />
                        </button>
                      )}
                      <button onClick={() => onEditar(item.original)} className="text-brand-burgundy hover:text-primary-900" title="Editar" aria-label="Editar">
                        <Edit className="h-4 w-4" />
                      </button>
                      <button onClick={() => onEliminar(item.recordatorioId)} className="text-danger-600 hover:text-danger-900" title="Eliminar" aria-label="Eliminar">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    )}
  </div>
);

const Reminders = () => {
  const [bandeja, setBandeja] = useState({ items: [], conteo: { retrasado: 0, hoy: 0, pendiente: 0, completado: 0 } });
  const [vista, setVista] = useState('pendientes');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [ocupado, setOcupado] = useState(null);
  const [detallePago, setDetallePago] = useState(null);
  const [completarDosis, setCompletarDosis] = useState(null);
  const [hoy, setHoy] = useState(hoyTepicISO());
  const [automaticReminders, setAutomaticReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showAutomatic, setShowAutomatic] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteReminderId, setDeleteReminderId] = useState(null);
  const [editingReminder, setEditingReminder] = useState(null);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    type: 'pago',
    priority: 'media',
    date: hoyTepicISO(),
    status: 'pendiente'
  });

  const fetchReminders = useCallback(async () => {
    try {
      const response = await remindersAPI.getBandeja(vista);
      setBandeja(response.data.data);
    } catch (error) {
      toast.error('Error al cargar recordatorios');
    } finally {
      setLoading(false);
    }
  }, [vista]);

  useEffect(() => { fetchReminders(); }, [fetchReminders]);
  useEffect(() => { fetchAutomaticReminders(); }, []);

  // A medianoche (Tepic) los de ayer pasan a "Retrasado" sin recargar
  useEffect(() => {
    const t = setInterval(() => setHoy(hoyTepicISO()), 60000);
    return () => clearInterval(t);
  }, []);

  const refrescar = () => { fetchReminders(); avisarCambioRecordatorios(); };

  const completar = async (item) => {
    // Vacunas y desparasitaciones del carnet: preguntar si se aplicó (registrarla) o solo cerrar
    if (item.origen === 'carnet') { setCompletarDosis(item); return; }
    setOcupado(item.id);
    try {
      if (item.origen === 'carnet') await remindersAPI.atenderCarnet(item.carnetId, item.aplicacionId);
      else await remindersAPI.complete(item.recordatorioId);
      toast.success(vista === 'pendientes' ? 'Completado. Lo encuentras en "Completados".' : 'Recordatorio completado');
      refrescar();
    } catch (error) {
      toast.error(error.response?.data?.message || 'Error al completar recordatorio');
      refrescar();
    } finally {
      setOcupado(null);
    }
  };

  const notificar = async (item) => {
    setOcupado(item.id);
    try {
      if (item.origen === 'carnet') await remindersAPI.notificarDuenoCarnet(item.carnetId, item.aplicacionId);
      else await remindersAPI.notificarDueno(item.recordatorioId);
      toast.success('Aviso al dueño registrado. El recordatorio sigue pendiente.');
      refrescar();
    } catch (error) {
      toast.error(error.response?.data?.message || 'Error al registrar el aviso');
      refrescar();
    } finally {
      setOcupado(null);
    }
  };

  const texto = searchTerm.trim().toLowerCase();
  const bandejaFiltrada = (bandeja.items || [])
    .filter(i => filtroTipo === 'todos'
      || (filtroTipo === 'pago' && i.tipo === 'pago')
      || (filtroTipo === 'vacunas' && (i.tipo === 'vacuna' || i.tipo === 'desparasitante'))
      || (filtroTipo === 'otros' && !['pago', 'vacuna', 'desparasitante'].includes(i.tipo)))
    .filter(i => !texto || i.titulo?.toLowerCase().includes(texto) || i.descripcion?.toLowerCase().includes(texto))
    .map(i => (i.origen === 'manual' ? { ...i, original: aFormulario(i) } : i));
  const conteoVista = { retrasado: 0, hoy: 0, pendiente: 0, completado: 0 };
  bandejaFiltrada.forEach(i => { conteoVista[estadoActual(i, hoy)] += 1; });

  const fetchAutomaticReminders = async () => {
    try {
      const response = await remindersAPI.getAutomaticAll();
      setAutomaticReminders(response.data.data);
    } catch (error) {
      console.error('Error al cargar recordatorios automáticos:', error);
    }
  };

  const handleCreateReminder = () => {
    setEditingReminder(null);
    setFormData({
      title: '',
      description: '',
      type: 'pago',
      priority: 'media',
      date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mazatlan' }),
      status: 'pendiente'
    });
    setShowModal(true);
  };

  const handleEditReminder = (reminder) => {
    setEditingReminder(reminder);
    setFormData({
      title: reminder.title,
      description: reminder.description || '',
      type: reminder.type,
      priority: reminder.priority,
      date: new Date(reminder.date).toLocaleDateString('en-CA', { timeZone: 'UTC' }),
      status: reminder.status
    });
    setShowModal(true);
  };

  const handleDeleteReminder = async (reminderId) => {
    setDeleteReminderId(reminderId);
    setShowDeleteModal(true);
  };

  const confirmDelete = async () => {
    try {
      await remindersAPI.delete(deleteReminderId);
      toast.success('Recordatorio eliminado correctamente');
      refrescar();
    } catch (error) {
      toast.error('Error al eliminar recordatorio');
    }
  };

  const getUrgencyColor = (urgency) => {
    switch (urgency) {
      case 'vencida': return 'danger';
      case 'hoy': return 'danger';
      case 'manana': return 'warning';
      case 'proxima': return 'info';
      default: return 'info';
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingReminder) {
        await remindersAPI.update(editingReminder._id, formData);
        toast.success('Recordatorio actualizado correctamente');
      } else {
        await remindersAPI.create(formData);
        toast.success('Recordatorio creado correctamente');
      }
      setShowModal(false);
      refrescar();
    } catch (error) {
      toast.error('Error al guardar recordatorio');
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Skeleton variant="title" className="w-48" />
            <Skeleton variant="text" className="w-64 mt-2" />
          </div>
          <Skeleton variant="button" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">Recordatorios</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-dark-textSecondary">
            Gestiona tus recordatorios y tareas pendientes
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-full sm:w-64">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-dark-textSecondary" />
              <input
                type="text"
                placeholder="Buscar recordatorios..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="form-input pl-10"
              />
            </div>
          </div>
          <button 
            onClick={() => setShowAutomatic(!showAutomatic)}
            className={`btn btn-md ${showAutomatic ? 'btn-primary' : 'btn-secondary'}`}
          >
            {showAutomatic ? 'Ver Manuales' : 'Ver Automáticos'}
          </button>
          <button onClick={handleCreateReminder} className="btn btn-primary btn-md">
            <Plus className="h-4 w-4 mr-2" />
            Nuevo Recordatorio
          </button>
        </div>
      </div>

      {/* Automatic Reminders */}
      {showAutomatic && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-dark-card-50 border border-gray-200 dark:border-dark-border rounded-lg p-4">
            <p className="text-sm text-blue-800">
              <strong>Recordatorios automáticos:</strong> Generados automáticamente desde cuentas por pagar y carnets de vacunación.
            </p>
          </div>
          
          {automaticReminders.length === 0 ? (
            <div className="text-center py-8 text-gray-50 dark:bg-dark-surface0 dark:text-dark-textSecondary">
              No hay recordatorios automáticos pendientes
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {automaticReminders.filter(reminder =>
                reminder.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                reminder.description?.toLowerCase().includes(searchTerm.toLowerCase())
              ).map((reminder) => (
                <div key={reminder.id} className="card">
                  <div className="card-body">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="text-lg font-medium text-gray-700 dark:text-dark-textSecondary dark:text-dark-text">{reminder.title}</h3>
                        {reminder.description && (
                          <p className="mt-1 text-sm text-gray-600 dark:text-dark-textSecondary">{reminder.description}</p>
                        )}
                        <div className="mt-3 space-y-2">
                          <div className="flex items-center text-sm text-gray-600 dark:text-dark-textSecondary">
                            <Calendar className="h-4 w-4 mr-2" />
                            {new Date(reminder.date).toLocaleDateString('es-MX', { timeZone: 'UTC' })}
                          </div>
                          <div className="flex items-center justify-between">
                            <span className={`capitalize badge badge-${getUrgencyColor(reminder.urgency)}`}>
                              {reminder.urgencyText}
                            </span>
                            <span className="text-xs text-gray-50 dark:bg-dark-surface0 dark:text-dark-textSecondary capitalize">
                              {reminder.type.replace('_', ' ')}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Manual Reminders */}
      {!showAutomatic && <Bandeja items={bandejaFiltrada} conteo={conteoVista} vista={vista} setVista={setVista} filtroTipo={filtroTipo} setFiltroTipo={setFiltroTipo} hoy={hoy} onCompletar={completar} onNotificar={notificar} onEditar={handleEditReminder} onVerPago={setDetallePago} onEliminar={handleDeleteReminder} ocupado={ocupado} />}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="modal-overlay" onClick={() => setShowModal(false)} />
            
            <div className="relative modal-content max-w-md w-full sm:max-w-md p-6 animate-slide-up">
              <h3 className="text-lg font-semibold text-gray-700 dark:text-dark-textSecondary dark:text-dark-text mb-4">
                {editingReminder ? 'Editar Recordatorio' : 'Nuevo Recordatorio'}
              </h3>
              <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="form-label">Título</label>
                  <input
                    type="text"
                    required
                    value={formData.title}
                    onChange={(e) => setFormData({...formData, title: e.target.value})}
                    className="form-input"
                  />
                </div>
                <div>
                  <label className="form-label">Descripción</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => setFormData({...formData, description: e.target.value})}
                    className="form-input"
                    rows="3"
                  />
                </div>
                <div>
                  <label className="form-label">Tipo</label>
                  <select
                    value={formData.type}
                    onChange={(e) => setFormData({...formData, type: e.target.value})}
                    className="form-input"
                  >
                    <option value="pago">Pago</option>
                    <option value="vacuna">Vacuna</option>
                    <option value="consulta">Consulta</option>
                    <option value="cita">Cita</option>
                    <option value="inventario">Inventario</option>
                    <option value="mantenimiento">Mantenimiento</option>
                    <option value="otro">Otro</option>
                  </select>
                </div>
                <div>
                  <label className="form-label">Prioridad</label>
                  <select
                    value={formData.priority}
                    onChange={(e) => setFormData({...formData, priority: e.target.value})}
                    className="form-input"
                  >
                    <option value="baja">Baja</option>
                    <option value="media">Media</option>
                    <option value="alta">Alta</option>
                  </select>
                </div>
                <div>
                  <label className="form-label">Fecha</label>
                  <input
                    type="date"
                    required
                    value={formData.date}
                    onChange={(e) => setFormData({...formData, date: e.target.value})}
                    className="form-input"
                  />
                </div>
                <div className="flex justify-end space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="btn btn-secondary btn-md"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary btn-md"
                  >
                    {editingReminder ? 'Actualizar' : 'Crear'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
      {detallePago && (
        <DetallePagoModal
          recordatorio={detallePago}
          onClose={() => setDetallePago(null)}
          onEditar={() => { const r = detallePago.original; setDetallePago(null); handleEditReminder(r); }}
        />
      )}
      {completarDosis && (
        <CompletarDosisModal
          item={completarDosis}
          onClose={() => setCompletarDosis(null)}
          onListo={() => { setCompletarDosis(null); refrescar(); }}
        />
      )}
      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          setDeleteReminderId(null);
        }}
        onConfirm={confirmDelete}
        title="Eliminar recordatorio"
        message="¿Estás seguro de que deseas eliminar este recordatorio? Esta acción no se puede deshacer."
        confirmText="Eliminar"
        type="danger"
      />
    </div>
  );
};

export default Reminders;

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Edit, ExternalLink } from 'lucide-react';
import { remindersAPI } from '../services/api';
import { formatCalendarDate } from '../helpers/dateUtils';
import { etiqueta } from '../helpers/etiquetas';

// Detalle de un recordatorio de pago: la cuenta por pagar ligada y la compra que la originó.
// Se abre con doble clic sobre un recordatorio de pago. Solo lectura.
const dinero = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const COLOR_ESTADO = { pagado: 'badge-success', pendiente: 'badge-warning', vencido: 'badge-danger', cancelada: 'badge-gray' };

const Dato = ({ titulo, children }) => (
  <div>
    <p className="text-xs text-gray-500 dark:text-dark-textSecondary">{titulo}</p>
    <p className="text-sm font-medium text-gray-800 dark:text-dark-text">{children}</p>
  </div>
);

const DetallePagoModal = ({ recordatorio, onClose, onEditar }) => {
  const navigate = useNavigate();
  const [estado, setEstado] = useState({ cargando: true, data: null, error: null });

  useEffect(() => {
    let vivo = true;
    remindersAPI.getDetallePago(recordatorio.recordatorioId)
      .then(r => { if (vivo) setEstado({ cargando: false, data: r.data.data, error: null }); })
      .catch(e => { if (vivo) setEstado({ cargando: false, data: null, error: e.response?.data?.message || 'No se pudo cargar el detalle' }); });
    return () => { vivo = false; };
  }, [recordatorio.recordatorioId]);

  useEffect(() => {
    const esc = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const { cargando, data, error } = estado;
  const cuenta = data?.cuenta;
  const compra = data?.compra;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Detalle del pago">
      <div className="flex items-center justify-center min-h-screen px-4 py-6">
        <div className="modal-overlay" onClick={onClose} />
        <div className="relative modal-content max-w-2xl w-full p-6 animate-slide-up space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-800 dark:text-dark-text">{recordatorio.titulo}</h3>
              <p className="text-sm text-gray-500 dark:text-dark-textSecondary">
                Recordatorio para el {formatCalendarDate(recordatorio.fecha)}
                {recordatorio.descripcion ? ` · ${recordatorio.descripcion}` : ''}
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Cerrar"><X className="h-5 w-5" /></button>
          </div>

          {cargando && <p className="text-sm text-gray-500">Cargando…</p>}
          {error && <p className="text-sm text-danger-600">{error}</p>}

          {!cargando && !error && !cuenta && (
            <div className="rounded-lg bg-warning-50 border border-warning-200 p-4 text-sm text-warning-800">
              {data?.liga === 'ambigua'
                ? 'Hay varias cuentas por pagar que podrían corresponder a este recordatorio; no se puede saber cuál es.'
                : 'Este recordatorio no está ligado a ninguna cuenta por pagar (puede ser un recordatorio capturado a mano).'}
            </div>
          )}

          {cuenta && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-gray-800 dark:text-dark-text">Cuenta por pagar</h4>
                <span className={`badge ${COLOR_ESTADO[cuenta.status] || 'badge-gray'}`}>{etiqueta(cuenta.status)}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Dato titulo="Proveedor">{cuenta.proveedor?.nombre || '—'}</Dato>
                <Dato titulo="Folio">{cuenta.folio || '—'}</Dato>
                <Dato titulo="Vence">{formatCalendarDate(cuenta.vence)}</Dato>
                <Dato titulo="Monto">{dinero(cuenta.monto)}</Dato>
                <Dato titulo="Pagado">{dinero(cuenta.pagado)}</Dato>
                <Dato titulo="Saldo pendiente"><span className={cuenta.saldo > 0 ? 'text-danger-600' : 'text-success-700'}>{dinero(cuenta.saldo)}</span></Dato>
              </div>
              {cuenta.descuentoDisponible > 0 && cuenta.fechaLimiteDescuento && (
                <p className="text-xs text-gray-600 dark:text-dark-textSecondary">
                  Descuento por pronto pago de {dinero(cuenta.descuentoDisponible)} hasta el {formatCalendarDate(cuenta.fechaLimiteDescuento)}.
                </p>
              )}
              {cuenta.pagos.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Pagos registrados</p>
                  <ul className="text-sm divide-y divide-gray-100 dark:divide-dark-border">
                    {cuenta.pagos.map((p, i) => (
                      <li key={i} className="py-1 flex justify-between gap-2">
                        <span>{formatCalendarDate(p.fecha)} · {etiqueta(p.metodo)}{p.usuario ? ` · ${p.usuario}` : ''}</span>
                        <span className="font-medium tabular-nums">{dinero(p.monto)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {cuenta && (
            <section className="space-y-3">
              <h4 className="font-semibold text-gray-800 dark:text-dark-text">Compra</h4>
              {!compra ? (
                <p className="text-sm text-gray-500">No se encontró la compra de esta cuenta.</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <Dato titulo="Fecha">{formatCalendarDate(compra.fecha)}</Dato>
                    <Dato titulo="Tipo">{etiqueta(compra.tipo)}</Dato>
                    <Dato titulo="Factura">{compra.factura || '—'}</Dato>
                    {compra.registradaPor && <Dato titulo="Registrada por">{compra.registradaPor}</Dato>}
                  </div>
                  {compra.recuperada && (
                    <p className="text-xs text-gray-600 dark:text-dark-textSecondary">Compra recuperada: se restauró sin el detalle de productos.</p>
                  )}
                  {compra.productos.length > 0 && (
                    <div className="table overflow-x-auto">
                      <table className="table-detalle w-full text-sm">
                        <thead>
                          <tr>
                            <th className="text-left">Producto</th>
                            <th className="text-right">Cant.</th>
                            <th className="text-right">Costo unit.</th>
                            <th className="text-right">Subtotal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {compra.productos.map((p, i) => (
                            <tr key={i}>
                              <td>{p.nombre}{p.sku ? <span className="text-xs text-gray-500"> · {p.sku}</span> : null}</td>
                              <td className="text-right tabular-nums">{p.cantidad}</td>
                              <td className="text-right tabular-nums">{dinero(p.costoUnitario)}</td>
                              <td className="text-right tabular-nums">{dinero(p.subtotal)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="flex justify-end gap-6 text-sm">
                    {compra.descuento > 0 && <span>Descuento: <strong>{dinero(compra.descuento)}</strong></span>}
                    <span>Total: <strong>{dinero(compra.total)}</strong></span>
                  </div>
                  {compra.notas && <p className="text-sm text-gray-600 dark:text-dark-textSecondary">Notas: {compra.notas}</p>}
                </>
              )}
            </section>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-gray-100 dark:border-dark-border">
            {cuenta && (
              <button onClick={() => navigate('/accounts-payable')} className="btn btn-secondary btn-md inline-flex items-center gap-1">
                <ExternalLink className="h-4 w-4" /> Ir a Cuentas por pagar
              </button>
            )}
            <button onClick={onEditar} className="btn btn-secondary btn-md inline-flex items-center gap-1">
              <Edit className="h-4 w-4" /> Editar recordatorio
            </button>
            <button onClick={onClose} className="btn btn-primary btn-md">Cerrar</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DetallePagoModal;

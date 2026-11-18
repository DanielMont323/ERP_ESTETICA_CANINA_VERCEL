import React, { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useSearchParams } from 'react-router-dom';
import { inventoryAPI, productsAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import Autocomplete from '../components/Autocomplete';
import { ClipboardCheck, Edit, Trash2 } from 'lucide-react';
import ConfirmModal from '../components/ConfirmModal';

// Qué quiere registrar la persona, en sus palabras. "conteo" calcula entrada o salida solo.
const OPCIONES = [
  { id: 'conteo', titulo: 'Conteo físico', ayuda: 'Contaste el producto y no coincide con el sistema', motivo: 'conteo_fisico' },
  { id: 'merma', titulo: 'Merma o daño', ayuda: 'Caducado, roto, dañado o perdido', tipo: 'salida', motivo: 'merma' },
  { id: 'uso_interno', titulo: 'Uso interno', ayuda: 'Se usó en el negocio y no se vendió', tipo: 'salida', motivo: 'uso_interno' },
  { id: 'regalo', titulo: 'Regalo o promoción', ayuda: 'Se regaló a un cliente', tipo: 'salida', motivo: 'regalo' },
  { id: 'devolucion', titulo: 'Devolución de cliente', ayuda: 'Un cliente regresó un producto en buen estado', tipo: 'entrada', motivo: 'devolucion_cliente' },
  { id: 'otro', titulo: 'Otro', ayuda: 'Cualquier otro caso (explícalo en la nota)', motivo: 'otro' }
];

const NOMBRES_MOTIVO = {
  conteo_fisico: 'Conteo físico', merma: 'Merma o daño', uso_interno: 'Uso interno',
  regalo: 'Regalo o promoción', devolucion_cliente: 'Devolución de cliente', otro: 'Otro'
};

const formatCurrency = n => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0);
const formatFecha = d => {
  const f = new Date(d);
  // Las fechas guardan la hora de Tepic en los componentes UTC
  return `${String(f.getUTCDate()).padStart(2, '0')}/${String(f.getUTCMonth() + 1).padStart(2, '0')}/${f.getUTCFullYear()} ${String(f.getUTCHours()).padStart(2, '0')}:${String(f.getUTCMinutes()).padStart(2, '0')}`;
};

const InventoryAdjustments = () => {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const productoDeLaUrl = searchParams.get('producto'); // viene del botón "Ajuste de inventario" en Productos
  const [producto, setProducto] = useState(null);
  const [opcion, setOpcion] = useState('conteo');
  const [cantidad, setCantidad] = useState('');
  const [contado, setContado] = useState('');
  const [tipoOtro, setTipoOtro] = useState('salida');
  const [costo, setCosto] = useState('');
  const [notas, setNotas] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [historial, setHistorial] = useState([]);
  const [cargandoHistorial, setCargandoHistorial] = useState(true);
  const [editando, setEditando] = useState(null); // ajuste del historial que se está corrigiendo
  const [porAnular, setPorAnular] = useState(null);

  const cargarHistorial = useCallback(async () => {
    try {
      const r = await inventoryAPI.getAdjustments({ limit: 50 });
      setHistorial(r.data.data);
    } catch (e) {
      toast.error('No se pudo cargar el historial de ajustes');
    } finally {
      setCargandoHistorial(false);
    }
  }, []);

  useEffect(() => { if (user?.role === 'admin') cargarHistorial(); }, [user, cargarHistorial]);

  const buscarProductos = async q => {
    try { return (await productsAPI.search(q)).data.data; } catch { return []; }
  };

  const seleccionarProducto = async id => {
    if (!id) { setProducto(null); return; }
    try {
      const r = await productsAPI.getById(id);
      setProducto(r.data.data);
    } catch {
      toast.error('No se pudo cargar el producto');
    }
  };

  // Si se llegó desde Productos, el producto ya queda seleccionado
  useEffect(() => {
    if (productoDeLaUrl && user?.role === 'admin') seleccionarProducto(productoDeLaUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productoDeLaUrl, user?.role]);

  const op = OPCIONES.find(o => o.id === opcion);
  // Al editar, el stock de referencia es el que habría SIN el ajuste original (se anula al guardar)
  const mismoProducto = !!(editando && producto && String(editando.producto?._id) === String(producto._id));
  const stock = producto ? producto.stock - (mismoProducto ? editando.quantity : 0) : 0;

  // Cálculo de lo que se va a registrar
  let tipo = op.tipo || (opcion === 'otro' ? tipoOtro : null);
  let piezas = parseInt(cantidad, 10);
  if (opcion === 'conteo') {
    const c = parseInt(contado, 10);
    if (contado !== '' && Number.isInteger(c) && c >= 0) {
      const diferencia = c - stock;
      tipo = diferencia > 0 ? 'entrada' : diferencia < 0 ? 'salida' : null;
      piezas = Math.abs(diferencia);
    } else {
      tipo = null; piezas = NaN;
    }
  }
  const piezasValidas = Number.isInteger(piezas) && piezas > 0;
  const quedara = tipo === 'salida' ? stock - piezas : stock + piezas;
  const faltaNota = opcion === 'otro' && !notas.trim();
  const excede = tipo === 'salida' && piezasValidas && piezas > stock;
  const listo = producto && tipo && piezasValidas && !excede && !faltaNota && !guardando;

  const limpiar = () => { setCantidad(''); setContado(''); setCosto(''); setNotas(''); setEditando(null); };

  const empezarEdicion = async (a) => {
    setEditando(a);
    await seleccionarProducto(a.producto?._id);
    const piezasOrig = Math.abs(a.quantity);
    const tipoOrig = a.type === 'ajuste_salida' ? 'salida' : 'entrada';
    const o = a.adjustmentReason === 'conteo_fisico' ? 'conteo'
      : a.adjustmentReason === 'devolucion_cliente' ? 'devolucion'
        : OPCIONES.find(x => x.motivo === a.adjustmentReason)?.id || 'otro';
    setOpcion(o);
    if (o === 'otro') setTipoOtro(tipoOrig);
    setContado(o === 'conteo' && a.stockContado !== undefined && a.stockContado !== null ? String(a.stockContado) : '');
    setCantidad(o === 'conteo' ? '' : String(piezasOrig));
    setCosto(tipoOrig === 'entrada' && a.unitCost ? String(Math.round(a.unitCost * 100) / 100) : '');
    setNotas(a.notes || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const anular = async () => {
    const a = porAnular;
    try {
      const r = await inventoryAPI.cancelAdjustment(a._id);
      toast.success(r.data.message);
      if (producto && String(producto._id) === String(a.producto?._id)) setProducto(p => ({ ...p, stock: r.data.data.stockDespues }));
      if (editando && editando._id === a._id) limpiar();
      cargarHistorial();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo eliminar el ajuste');
    }
  };

  const registrar = async () => {
    if (!listo) return;
    setGuardando(true);
    try {
      const datos = {
        producto: producto._id,
        tipo,
        cantidad: piezas,
        motivo: op.motivo,
        notas: notas.trim() || undefined,
        costoUnitario: tipo === 'entrada' && costo !== '' ? Number(costo) : undefined,
        stockEsperado: stock,
        stockContado: opcion === 'conteo' ? parseInt(contado, 10) : undefined
      };
      const r = editando ? await inventoryAPI.updateAdjustment(editando._id, datos) : await inventoryAPI.createAdjustment(datos);
      toast.success(r.data.message);
      setProducto(p => ({ ...p, stock: r.data.data.stockDespues }));
      limpiar();
      cargarHistorial();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo registrar el ajuste');
    } finally {
      setGuardando(false);
    }
  };

  if (user?.role !== 'admin') {
    return (
      <div className="card"><div className="card-body text-gray-600 dark:text-dark-textSecondary">
        Solo un administrador puede registrar ajustes de inventario.
      </div></div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-dark-text flex items-center gap-2">
          <ClipboardCheck className="h-6 w-6 text-brand-burgundy" /> Ajustes de Inventario
        </h1>
        <p className="text-sm text-gray-500 dark:text-dark-textSecondary mt-1">
          Registra mermas, productos dañados, uso interno o diferencias del conteo físico. El stock se corrige y queda el registro de quién lo hizo y por qué.
        </p>
      </div>

      <div className="card">
        <div className="card-body space-y-5">
          {editando && (
            <div className="rounded-lg border border-blue-300 bg-blue-50 dark:bg-transparent p-3 text-sm text-blue-900 dark:text-dark-textSecondary flex flex-wrap items-center justify-between gap-2">
              <span>
                Editando el ajuste del <strong>{formatFecha(editando.date)}</strong> ({editando.quantity > 0 ? '+' : ''}{editando.quantity} {editando.producto?.name}).
                Al guardar se anula el original y se registra el corregido; ambos quedan en el historial.
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={limpiar}>Cancelar edición</button>
            </div>
          )}
          <div>
            <label className="form-label">1. Producto</label>
            <Autocomplete
              placeholder="Buscar producto por nombre o SKU..."
              fetchOptions={buscarProductos}
              displayValue={item => `${item.name} (${item.sku || 'Sin SKU'})`}
              getOptionValue={item => item._id}
              value={producto}
              onChange={seleccionarProducto}
              minLength={1}
            />
            {producto && (
              <p className="mt-2 text-sm text-gray-700 dark:text-dark-textSecondary">
                {mismoProducto ? 'Stock sin el ajuste que estás editando' : 'Stock en el sistema'}: <span className="font-bold text-lg">{stock}</span> piezas
                {mismoProducto && <span className="text-xs text-gray-500"> (hoy el sistema tiene {producto.stock})</span>}
              </p>
            )}
          </div>

          <div>
            <label className="form-label">2. ¿Qué pasó?</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {OPCIONES.map(o => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setOpcion(o.id)}
                  className={`text-left rounded-lg border p-3 transition ${
                    opcion === o.id
                      ? 'border-brand-burgundy bg-red-50 dark:bg-transparent ring-1 ring-brand-burgundy'
                      : 'border-gray-200 dark:border-dark-border hover:border-gray-400'
                  }`}
                >
                  <span className="block font-medium text-gray-900 dark:text-dark-text">{o.titulo}</span>
                  <span className="block text-xs text-gray-500 dark:text-dark-textSecondary">{o.ayuda}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {opcion === 'conteo' ? (
              <div>
                <label className="form-label">3. ¿Cuántas piezas contaste?</label>
                <input type="number" min="0" step="1" className="form-input" value={contado}
                  onChange={e => setContado(e.target.value)} placeholder="Piezas físicas" />
              </div>
            ) : (
              <div>
                <label className="form-label">3. ¿Cuántas piezas?</label>
                <input type="number" min="1" step="1" className="form-input" value={cantidad}
                  onChange={e => setCantidad(e.target.value)} placeholder="Piezas" />
              </div>
            )}
            {opcion === 'otro' && (
              <div>
                <label className="form-label">¿Entran o salen del inventario?</label>
                <select className="form-input" value={tipoOtro} onChange={e => setTipoOtro(e.target.value)}>
                  <option value="salida">Salen (se descuentan)</option>
                  <option value="entrada">Entran (se suman)</option>
                </select>
              </div>
            )}
            {tipo === 'entrada' && (
              <div>
                <label className="form-label">Costo por pieza (opcional)</label>
                <input type="number" min="0" step="0.01" className="form-input" value={costo}
                  onChange={e => setCosto(e.target.value)} placeholder="Vacío = último costo de compra" />
              </div>
            )}
          </div>

          <div>
            <label className="form-label">Nota {opcion === 'otro' ? '(obligatoria)' : '(opcional)'}</label>
            <input type="text" className="form-input" value={notas} maxLength={300}
              onChange={e => setNotas(e.target.value)} placeholder="Ej. 2 bolsas rotas al acomodar" />
          </div>

          {producto && (opcion === 'conteo' ? contado !== '' : cantidad !== '') && (
            <div className={`rounded-lg border p-3 text-sm ${excede ? 'border-red-300 bg-red-50 text-red-800' : 'border-yellow-300 bg-yellow-50 text-gray-800'} dark:bg-transparent dark:text-dark-textSecondary`}>
              {opcion === 'conteo' && !tipo && piezas === 0
                ? 'El conteo coincide con el sistema. No hay nada que ajustar.'
                : excede
                  ? `No puedes sacar ${piezas} piezas: el sistema solo tiene ${stock}.`
                  : piezasValidas && tipo
                    ? <>Se registrará una <strong>{tipo === 'salida' ? 'salida' : 'entrada'} de {piezas} {piezas === 1 ? 'pieza' : 'piezas'}</strong> ({NOMBRES_MOTIVO[op.motivo]}). El stock pasará de <strong>{stock}</strong> a <strong>{quedara}</strong>.
                      {tipo === 'salida' && ' Su costo se registrará como pérdida en el reporte de ganancia.'}</>
                    : 'Escribe una cantidad válida (número entero).'}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary btn-md" onClick={limpiar} disabled={guardando}>Limpiar</button>
            <button type="button" className="btn btn-primary btn-md" onClick={registrar} disabled={!listo}>
              {guardando ? 'Guardando...' : editando ? 'Guardar corrección' : 'Registrar ajuste'}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="text-base sm:text-lg font-medium text-gray-600 dark:text-dark-textSecondary">ÚLTIMOS AJUSTES</h3>
        </div>
        <div className="card-body">
          {cargandoHistorial ? (
            <p className="text-sm text-gray-500">Cargando...</p>
          ) : historial.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-dark-textSecondary">Todavía no hay ajustes registrados.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-600 dark:text-dark-textSecondary border-b border-gray-200 dark:border-dark-border">
                    <th className="py-2 pr-3">Fecha</th>
                    <th className="py-2 pr-3">Producto</th>
                    <th className="py-2 pr-3">Motivo</th>
                    <th className="py-2 pr-3 text-right">Piezas</th>
                    <th className="py-2 pr-3 text-right">Costo</th>
                    <th className="py-2 pr-3">Quién</th>
                    <th className="py-2 pr-3">Nota</th>
                    <th className="py-2 text-right"><span className="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  {historial.map(a => (
                    <tr key={a._id} className={`border-b border-gray-100 dark:border-dark-border align-top ${a.anulado ? 'opacity-60' : ''} ${editando?._id === a._id ? 'bg-blue-50 dark:bg-transparent' : ''}`}>
                      <td className="py-2 pr-3 whitespace-nowrap">{formatFecha(a.date)}</td>
                      <td className="py-2 pr-3">{a.producto?.name || '—'}</td>
                      <td className="py-2 pr-3">{NOMBRES_MOTIVO[a.adjustmentReason] || '—'}</td>
                      <td className={`py-2 pr-3 text-right font-semibold whitespace-nowrap ${a.quantity < 0 ? 'text-danger-600' : 'text-success-600'}`}>
                        {a.quantity > 0 ? '+' : ''}{a.quantity}
                      </td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{formatCurrency(a.totalCost)}</td>
                      <td className="py-2 pr-3">{a.user?.name || '—'}</td>
                      <td className="py-2 pr-3 text-gray-600 dark:text-dark-textSecondary">
                        {a.anulado && (
                          <span className="badge badge-gray mb-1" title={a.anulado.nota}>
                            {/editado/.test(a.anulado.nota) ? 'Corregido' : 'Eliminado'} el {formatFecha(a.anulado.fecha)}{a.anulado.usuario ? ` por ${a.anulado.usuario}` : ''}
                          </span>
                        )}
                        {a.notes || ''}
                        {a.stockContado !== undefined && a.stockContado !== null && (
                          <span className="block text-xs">Sistema {a.stockAntes} · contado {a.stockContado}</span>
                        )}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {!a.anulado && (
                          <span className="table-actions">
                            <button type="button" onClick={() => empezarEdicion(a)} className="p-1.5 rounded-md text-gray-500 hover:text-brand-burgundy hover:bg-gray-100 dark:hover:bg-dark-hover" title="Editar ajuste" aria-label="Editar ajuste">
                              <Edit className="h-4 w-4" />
                            </button>
                            <button type="button" onClick={() => setPorAnular(a)} className="p-1.5 rounded-md text-gray-500 hover:text-danger-600 hover:bg-danger-50" title="Eliminar ajuste" aria-label="Eliminar ajuste">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={!!porAnular}
        onClose={() => setPorAnular(null)}
        onConfirm={anular}
        title="Eliminar ajuste"
        message={porAnular ? `Se deshará el ajuste de ${porAnular.quantity > 0 ? '+' : ''}${porAnular.quantity} ${porAnular.producto?.name || ''}: el stock regresa a como estaba. El ajuste queda en el historial marcado como eliminado.` : ''}
        confirmText="Eliminar"
        type="danger"
      />
    </div>
  );
};

export default InventoryAdjustments;

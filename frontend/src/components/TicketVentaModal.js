import React, { useEffect, useState } from 'react';
import jsPDF from 'jspdf';
import toast from 'react-hot-toast';
import { X, Printer, Download, Share2 } from 'lucide-react';
import { formatCalendarDate } from '../helpers/dateUtils';

// Ticket de venta para imprimir, descargar en PDF o compartir (WhatsApp, correo…) con el cliente.
// Solo lectura: no cambia la venta. Formato de ticket de 80 mm.

const NEGOCIO = { nombre: 'Barber Dog', lema: 'Estética canina · Tepic, Nay.' };
const METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };

const dinero = n => `$${(Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nombreDe = v => (v && typeof v === 'object' ? v.name : '') || '';
export const folioDe = venta => String(venta?._id || '').slice(-6).toUpperCase();

// Las fechas se guardan con la hora de Tepic en UTC: se leen los componentes UTC.
const horaDe = f => {
  const d = new Date(f);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

export function datosTicket(venta) {
  const lineas = (venta.items || []).map(it => {
    const cantidad = Number(it.quantity) || 1;
    const antes = Number(it.subtotalBeforeDiscount) || cantidad * (Number(it.unitPrice) || 0);
    const descuento = Number(it.discountAmount) || 0;
    const proximas = (it.aplicaciones || []).map(a => a.proximaDosis).filter(Boolean);
    return {
      clave: `${it.type}|${String(it.item?._id || it.item || '')}`,
      nombre: nombreDe(it.item) || (it.type === 'servicio' ? 'Servicio' : 'Producto'),
      cantidad,
      precio: Number(it.unitPrice) || 0,
      importe: antes,
      descuento: venta.employeeDiscountApplied ? 0 : descuento,
      mascota: nombreDe(it.mascota) || [...new Set((it.aplicaciones || []).map(a => nombreDe(a.mascota)).filter(Boolean))].join(', '),
      proximaDosis: proximas.length ? formatCalendarDate(proximas[0]) : (it.nextDoseDate ? formatCalendarDate(it.nextDoseDate) : '')
    };
  });
  // Un servicio con cantidad > 1 se guarda como una línea por unidad (una por mascota). En el ticket se juntan
  // las líneas del mismo artículo y precio: "20 x Transporte Carro" en lugar de veinte "1 x Transporte Carro".
  const items = [];
  lineas.forEach(l => {
    const igual = items.find(i => i.clave === l.clave && i.precio === l.precio && i.proximaDosis === l.proximaDosis);
    if (!igual) { items.push({ ...l }); return; }
    igual.cantidad += l.cantidad;
    igual.importe += l.importe;
    igual.descuento += l.descuento;
    igual.mascota = [...new Set([igual.mascota, l.mascota].join(', ').split(', ').filter(Boolean))].join(', ');
  });
  const subtotal = Number(venta.subtotal) || items.reduce((s, i) => s + i.importe, 0);
  const descuento = Number(venta.totalDiscount) || items.reduce((s, i) => s + i.descuento, 0);
  return {
    folio: folioDe(venta),
    fecha: formatCalendarDate(venta.date),
    hora: horaDe(venta.date),
    cliente: nombreDe(venta.customer) || 'Público en general',
    mascota: nombreDe(venta.mascota),
    atendio: nombreDe(venta.user),
    items,
    subtotal,
    descuento,
    descuentoEmpleado: !!venta.employeeDiscountApplied,
    total: Number(venta.total) || subtotal - descuento,
    pagos: (venta.payments && venta.payments.length ? venta.payments : [{ method: venta.paymentMethod, amount: venta.total }])
      .map(p => ({ metodo: METODO[p.method] || p.method || 'Pago', monto: Number(p.amount) || 0 })),
    cambio: Number(venta.change) || 0,
    cancelada: venta.status === 'cancelada',
    notas: venta.notes || ''
  };
}

let logoCache = null;
async function cargarLogo() {
  if (logoCache !== null) return logoCache;
  try {
    // Se reduce a 200 px en JPEG (fondo blanco) para que el PDF pese poco (el original es un PNG de 500 px)
    logoCache = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 200;
        c.height = 200;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 200, 200);
        ctx.drawImage(img, 0, 0, 200, 200);
        res(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = rej;
      img.src = '/logo.png';
    });
  } catch (e) {
    logoCache = '';
  }
  return logoCache;
}

// Dibuja el ticket. Con pdf = null solo calcula el alto necesario.
function dibujar(pdf, t, logo, ancho) {
  const m = 4;
  const util = ancho - m * 2;
  let y = 5;
  const medir = pdf || new jsPDF({ unit: 'mm', format: [ancho, 200] });
  const texto = (str, { size = 8, bold = false, align = 'left', x } = {}) => {
    medir.setFont('helvetica', bold ? 'bold' : 'normal');
    medir.setFontSize(size);
    const lineas = medir.splitTextToSize(String(str), util);
    const alto = size * 0.42;
    lineas.forEach(l => {
      if (pdf) {
        const px = x !== undefined ? x : align === 'center' ? ancho / 2 : align === 'right' ? ancho - m : m;
        pdf.text(l, px, y, { align });
      }
      y += alto;
    });
  };
  const fila = (izq, der, { size = 8, bold = false } = {}) => {
    medir.setFont('helvetica', bold ? 'bold' : 'normal');
    medir.setFontSize(size);
    const derAncho = medir.getTextWidth(der) + 2;
    const lineas = medir.splitTextToSize(String(izq), util - derAncho);
    lineas.forEach((l, i) => {
      if (pdf) {
        pdf.text(l, m, y);
        if (i === 0) pdf.text(der, ancho - m, y, { align: 'right' });
      }
      y += size * 0.42;
    });
  };
  const linea = () => {
    y += 1;
    if (pdf) {
      pdf.setLineDashPattern([0.8, 0.8], 0);
      pdf.setDrawColor(150);
      pdf.line(m, y, ancho - m, y);
      pdf.setLineDashPattern([], 0);
    }
    y += 3;
  };

  if (logo) {
    if (pdf) pdf.addImage(logo, 'JPEG', ancho / 2 - 9, y, 18, 18);
    y += 21;
  }
  y += 1;
  texto(NEGOCIO.nombre, { size: 13, bold: true, align: 'center' });
  texto(NEGOCIO.lema, { size: 8, align: 'center' });
  linea();
  texto('TICKET DE VENTA', { size: 9, bold: true, align: 'center' });
  if (t.cancelada) texto('*** VENTA CANCELADA ***', { size: 9, bold: true, align: 'center' });
  fila(`Folio: ${t.folio}`, `${t.fecha} ${t.hora}`);
  texto(`Cliente: ${t.cliente}`);
  if (t.mascota) texto(`Mascota: ${t.mascota}`);
  if (t.atendio) texto(`Atendió: ${t.atendio}`);
  linea();
  t.items.forEach(i => {
    fila(`${i.cantidad} x ${i.nombre}`, dinero(i.importe), { bold: true });
    if (i.cantidad > 1) texto(`   ${dinero(i.precio)} c/u`, { size: 7 });
    if (i.mascota) texto(`   Mascota: ${i.mascota}`, { size: 7 });
    if (i.descuento > 0) fila('   Descuento', `-${dinero(i.descuento)}`, { size: 7 });
    if (i.proximaDosis) texto(`   Próxima dosis: ${i.proximaDosis}`, { size: 7 });
    y += 1;
  });
  linea();
  fila('Subtotal', dinero(t.subtotal));
  if (t.descuento > 0) fila(t.descuentoEmpleado ? 'Descuento (20%)' : 'Descuento', `-${dinero(t.descuento)}`);
  fila('TOTAL', dinero(t.total), { size: 11, bold: true });
  y += 1;
  t.pagos.forEach(p => fila(p.metodo, dinero(p.monto)));
  if (t.cambio > 0) fila('Cambio', dinero(t.cambio));
  if (t.notas) {
    linea();
    texto(`Notas: ${t.notas}`, { size: 7 });
  }
  linea();
  texto('¡Gracias por su preferencia!', { size: 9, bold: true, align: 'center' });
  return y + 4;
}

async function crearPdf(venta) {
  const t = datosTicket(venta);
  const logo = await cargarLogo();
  const ancho = 80;
  const alto = Math.max(100, dibujar(null, t, logo, ancho));
  const pdf = new jsPDF({ unit: 'mm', format: [ancho, alto] });
  dibujar(pdf, t, logo, ancho);
  return pdf;
}

const TicketVentaModal = ({ venta, onClose }) => {
  const [ocupado, setOcupado] = useState(false);
  const t = datosTicket(venta);
  const nombreArchivo = `ticket-barberdog-${t.folio}.pdf`;
  const puedeCompartir = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    cargarLogo();
    const esc = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const conPdf = async (accion) => {
    setOcupado(true);
    try {
      await accion(await crearPdf(venta));
    } catch (e) {
      if (e?.name !== 'AbortError') toast.error('No se pudo generar el ticket');
    } finally {
      setOcupado(false);
    }
  };

  const descargar = () => conPdf(async pdf => { pdf.save(nombreArchivo); toast.success('Ticket descargado'); });

  const imprimir = () => conPdf(async pdf => {
    const url = URL.createObjectURL(pdf.output('blob'));
    const marco = document.createElement('iframe');
    marco.style.position = 'fixed';
    marco.style.right = '0';
    marco.style.bottom = '0';
    marco.style.width = '0';
    marco.style.height = '0';
    marco.style.border = '0';
    marco.src = url;
    marco.onload = () => {
      try { marco.contentWindow.focus(); marco.contentWindow.print(); } catch (e) { window.open(url, '_blank'); }
      setTimeout(() => { marco.remove(); URL.revokeObjectURL(url); }, 60000);
    };
    document.body.appendChild(marco);
  });

  const compartir = () => conPdf(async pdf => {
    const archivo = new File([pdf.output('blob')], nombreArchivo, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
      await navigator.share({ files: [archivo], title: `Ticket ${t.folio}`, text: `Ticket de tu compra en ${NEGOCIO.nombre}` });
    } else {
      pdf.save(nombreArchivo);
      toast('Tu navegador no permite compartir archivos: se descargó el PDF para que lo envíes', { icon: 'ℹ️' });
    }
  });

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Ticket de venta">
      <div className="flex items-center justify-center min-h-screen px-4 py-6">
        <div className="modal-overlay" onClick={onClose} />
        <div className="relative modal-content max-w-sm w-full p-5 animate-slide-up space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-dark-text">Ticket #{t.folio}</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Cerrar"><X className="h-5 w-5" /></button>
          </div>

          {/* Vista previa (siempre en claro, como el papel) */}
          <div className="bg-white text-gray-900 rounded-lg border border-gray-200 shadow-inner p-4 font-mono text-xs max-h-[55vh] overflow-y-auto">
            <div className="text-center">
              <img src="/logo.png" alt="" className="h-14 w-14 mx-auto mb-1 object-contain" />
              <p className="font-bold text-base font-sans">{NEGOCIO.nombre}</p>
              <p className="text-[11px]">{NEGOCIO.lema}</p>
            </div>
            <hr className="border-dashed border-gray-400 my-2" />
            <p className="text-center font-bold">TICKET DE VENTA</p>
            {t.cancelada && <p className="text-center font-bold text-danger-600">*** VENTA CANCELADA ***</p>}
            <div className="flex justify-between"><span>Folio: {t.folio}</span><span>{t.fecha} {t.hora}</span></div>
            <p>Cliente: {t.cliente}</p>
            {t.mascota && <p>Mascota: {t.mascota}</p>}
            {t.atendio && <p>Atendió: {t.atendio}</p>}
            <hr className="border-dashed border-gray-400 my-2" />
            {t.items.map((i, k) => (
              <div key={k} className="mb-1.5">
                <div className="flex justify-between gap-2 font-bold"><span>{i.cantidad} x {i.nombre}</span><span>{dinero(i.importe)}</span></div>
                {i.cantidad > 1 && <p className="pl-3 text-[11px]">{dinero(i.precio)} c/u</p>}
                {i.mascota && <p className="pl-3 text-[11px]">Mascota: {i.mascota}</p>}
                {i.descuento > 0 && <div className="pl-3 flex justify-between text-[11px]"><span>Descuento</span><span>-{dinero(i.descuento)}</span></div>}
                {i.proximaDosis && <p className="pl-3 text-[11px]">Próxima dosis: {i.proximaDosis}</p>}
              </div>
            ))}
            <hr className="border-dashed border-gray-400 my-2" />
            <div className="flex justify-between"><span>Subtotal</span><span>{dinero(t.subtotal)}</span></div>
            {t.descuento > 0 && <div className="flex justify-between"><span>{t.descuentoEmpleado ? 'Descuento (20%)' : 'Descuento'}</span><span>-{dinero(t.descuento)}</span></div>}
            <div className="flex justify-between font-bold text-sm"><span>TOTAL</span><span>{dinero(t.total)}</span></div>
            {t.pagos.map((p, k) => <div key={k} className="flex justify-between"><span>{p.metodo}</span><span>{dinero(p.monto)}</span></div>)}
            {t.cambio > 0 && <div className="flex justify-between"><span>Cambio</span><span>{dinero(t.cambio)}</span></div>}
            {t.notas && (<><hr className="border-dashed border-gray-400 my-2" /><p className="text-[11px]">Notas: {t.notas}</p></>)}
            <hr className="border-dashed border-gray-400 my-2" />
            <p className="text-center font-bold">¡Gracias por su preferencia!</p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <button type="button" onClick={imprimir} disabled={ocupado} className="btn btn-secondary btn-md inline-flex items-center justify-center gap-1">
              <Printer className="h-4 w-4" /> Imprimir
            </button>
            <button type="button" onClick={descargar} disabled={ocupado} className="btn btn-secondary btn-md inline-flex items-center justify-center gap-1">
              <Download className="h-4 w-4" /> PDF
            </button>
            <button type="button" onClick={compartir} disabled={ocupado} className="btn btn-primary btn-md inline-flex items-center justify-center gap-1" title={puedeCompartir ? 'Enviar por WhatsApp, correo, etc.' : 'Descarga el PDF para enviarlo'}>
              <Share2 className="h-4 w-4" /> Enviar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TicketVentaModal;

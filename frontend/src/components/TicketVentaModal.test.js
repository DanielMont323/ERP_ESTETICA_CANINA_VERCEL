jest.mock('jspdf', () => function jsPDF() {});
import { datosTicket } from './TicketVentaModal';

const transporte = { _id: 'srv1', name: 'Transporte Carro' };
const bano = { _id: 'srv2', name: 'Baño pelo corto' };
const linea = (item, precio, mascota, extra = {}) => ({
  type: 'servicio', item, quantity: 1, unitPrice: precio, subtotalBeforeDiscount: precio, discountAmount: 0, mascota, ...extra
});

test('junta las unidades del mismo servicio en una sola línea', () => {
  const venta = {
    _id: 'abc123456789',
    items: [
      ...Array.from({ length: 20 }, () => linea(transporte, 10, { name: 'Bruno' })),
      linea(bano, 200, { name: 'Bruno' }),
      linea(bano, 200, { name: 'Inoue' }, { discountAmount: 20 })
    ],
    subtotal: 600,
    total: 580
  };
  const t = datosTicket(venta);
  expect(t.items).toHaveLength(2);
  expect(t.items[0]).toMatchObject({ nombre: 'Transporte Carro', cantidad: 20, precio: 10, importe: 200, mascota: 'Bruno' });
  expect(t.items[1]).toMatchObject({ nombre: 'Baño pelo corto', cantidad: 2, importe: 400, descuento: 20, mascota: 'Bruno, Inoue' });
});

test('no junta el mismo artículo con distinto precio', () => {
  const t = datosTicket({ _id: 'x', items: [linea(transporte, 10, null), linea(transporte, 12, null)] });
  expect(t.items.map(i => i.cantidad)).toEqual([1, 1]);
});

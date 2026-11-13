// Doble clic sobre un registro de una lista (fila o tarjeta) para abrirlo y editarlo.
// - No se activa si el doble clic fue sobre un botón, enlace o campo dentro del registro.
// - Quita la selección de texto que el navegador hace con el doble clic.
export const alDobleClic = (abrir) => (e) => {
  if (e.target.closest('button, a, input, select, textarea, label')) return;
  if (window.getSelection) window.getSelection().removeAllRanges();
  abrir();
};

export const TITULO_DOBLE_CLIC = 'Doble clic para abrir';

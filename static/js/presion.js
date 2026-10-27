/* ═══════════════════════════════════════════════
   Utilidades de mapa compartidas por la vista territorial (territorio.js) y el
   registro geográfico (registro.js): situaciones de un permiso activo, carga
   diferida de Leaflet (alojado localmente) y formato de fechas.
   ═══════════════════════════════════════════════ */
'use strict';

const PRES_SIT = [
  { key: 'ejecucion',  label: 'En ejecución hoy',     color: '#1D4D0B' },
  { key: 'programado', label: 'Programados',          color: '#6EAA4B' },
  { key: 'evaluacion', label: 'En evaluación',        color: '#D9A13B' },
];
let _leafletListo = null;

function _cargarLeaflet() {
  if (window.L) return Promise.resolve();
  if (_leafletListo) return _leafletListo;
  _leafletListo = new Promise((ok, mal) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/static/vendor/leaflet-1.9.4/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = '/static/vendor/leaflet-1.9.4/leaflet.js';
    js.onload = ok;
    js.onerror = () => mal(new Error('No se pudo cargar el mapa'));
    document.head.appendChild(js);
  });
  return _leafletListo;
}

const _fechaCorta = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' }) : '–';

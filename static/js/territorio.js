/* ═══════════════════════════════════════════════
   Vista territorial del Resumen: dónde se concentran los permisos activos.
   Tres escalas con el mismo mapa:
     País   → una burbuja por área protegida (tamaño = permisos activos).
     Región → límites de sus áreas coloreados por presión + coordenadas declaradas
              + registro geográfico del portal del investigador.
     Área   → acercamiento al área: cada permiso en el mapa, calendario de
              actividades que coinciden y superposiciones entre permisos.
   Datos: /api/territorio (tramites/api.py, tramites/presion.py).
   Usa de presion.js: PRES_SIT, _cargarLeaflet, _fechaCorta. De panorama.js: _esc, _fmt.
   ═══════════════════════════════════════════════ */
'use strict';

const TERR_ESCALA_COLOR = ['#E5F1DA', '#B9DA9F', '#8CC26B', '#4A9324', '#2C6B14', '#0A4A2B'];   // presión: claro → oscuro
const TERR_REG = { punto: '#B9412F', linea: '#0155A0', poligono: '#7A3FA0' };
const _terrCache = new Map();
let _terrMapa = null;
let _terr = { region: null, tipo: null, area: null, datos: null, pendienteArea: null };

const _terrPlural = (n, a, b) => `${_fmt(n)} ${n === 1 ? a : b}`;
const _terrDensidad = a => a.km2 ? a.activos / a.km2 : null;   // permisos por km² (solo para ordenar)
const _terrKm2 = km2 => km2 < 1 ? `${Math.round(km2 * 100)} ha` : `${_fmt(Math.round(km2))} km²`;
const _terrNivel = (v, max) => v ? Math.min(TERR_ESCALA_COLOR.length - 1, 1 + Math.floor(v / Math.max(max, 1) * (TERR_ESCALA_COLOR.length - 1.01))) : 0;

async function _terrDatos(tipo, region) {
  const clave = `${tipo}|${region || ''}`;
  if (_terrCache.has(clave)) return _terrCache.get(clave);
  const q = new URLSearchParams({ tipo, ...(region ? { region } : {}) });
  const r = await fetch(`/api/territorio?${q}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'error');
  _terrCache.set(clave, j);
  return j;
}

function _terrBarra(a, max) {
  return `<span class="terr-barra">${PRES_SIT.map(s => a[s.key]
    ? `<span style="width:${a[s.key] / max * 100}%;background:${s.color}"></span>` : '').join('')}</span>`;
}

function _terrMigas() {
  const fijo = window.PERFIL?.solo_su_region;
  const m = [];
  if (!fijo) m.push(_terr.region || _terr.area ? '<button data-terr-ir="pais">Todo el país</button>' : '<span>Todo el país</span>');
  const conArea = _terr.area || _terr.areaNombre;
  if (_terr.region) m.push(conArea ? `<button data-terr-ir="region">${_esc(_terr.region)}</button>` : `<span>${_esc(_terr.region)}</span>`);
  if (_terr.area) m.push(`<span>${_esc(_terr.area.area)}</span>`);
  else if (_terr.areaNombre) m.push(`<span>${_esc(_terr.areaNombre)} <small>(sin permisos activos)</small></span>`);
  return `<nav class="terr-migas" aria-label="Escala">${m.join('<i aria-hidden="true">›</i>')}</nav>`;
}

// ─── Panel lateral según la escala ────────────────────────────────────────────
function _terrLado() {
  const d = _terr.datos;
  if (_terr.area) return _terrLadoArea(_terr.area);
  const areas = d.areas.filter(a => a.activos);
  if (!areas.length) return '<p class="terr-vacio">No hay permisos activos ni en evaluación en áreas protegidas.</p>';
  const max = Math.max(...areas.map(a => a.activos), 1);
  // un permiso puede abarcar varias áreas: los totales cuentan permisos distintos
  const ids = new Set(), enEjec = new Set();
  areas.forEach(a => {
    (a.ids || a.permisos.map(p => p.id)).forEach(i => ids.add(i));
    (a.ids_ejecucion || a.permisos.filter(p => p.situacion === 'ejecucion').map(p => p.id)).forEach(i => enEjec.add(i));
  });
  const densas = areas.filter(a => _terrDensidad(a) !== null && a.activos >= 2)
    .sort((a, b) => _terrDensidad(b) - _terrDensidad(a)).slice(0, 3);
  const top = areas.slice(0, 10);
  return `
    <p class="terr-resumen"><strong>${_terrPlural(ids.size, 'permiso activo', 'permisos activos')}</strong> en
      ${_terrPlural(areas.length, 'área protegida', 'áreas protegidas')}; ${_fmt(enEjec.size)} en ejecución hoy.</p>
    <h4>Más permisos activos</h4>
    <ol class="terr-ranking">${top.map(a => `<li><button data-terr-area="${_esc(a.area)}" data-terr-region="${_esc(a.region || _terr.region)}">
      <span class="terr-nom">${_esc(a.area)}${!_terr.region && a.region ? `<small>${_esc(a.region)}</small>` : ''}</span>
      ${_terrBarra(a, max)}<em>${a.activos}</em></button></li>`).join('')}</ol>
    ${densas.length ? `<h4>Más permisos para su tamaño</h4>
      <ul class="terr-densas">${densas.map(a => `<li><button data-terr-area="${_esc(a.area)}" data-terr-region="${_esc(a.region || _terr.region)}">
        <span>${_esc(a.area)}</span><em>${a.activos} en ${_terrKm2(a.km2)}</em></button></li>`).join('')}</ul>
      <p class="terr-nota">Las áreas pequeñas con varios permisos simultáneos son las más expuestas a interferencias entre estudios.</p>` : ''}
    <div class="pano-legend terr-leyenda">${PRES_SIT.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div>`;
}

function _terrLadoArea(a) {
  const hoy = new Date();
  const ps = [...a.permisos].sort((x, y) => (x.inicio || '9') < (y.inicio || '9') ? -1 : 1);
  const fechas = ps.flatMap(p => [p.inicio, p.termino]).filter(Boolean).map(f => new Date(f + 'T12:00:00'));
  const min = new Date(Math.min(hoy, ...fechas)), max = new Date(Math.max(hoy, ...fechas));
  const span = Math.max(max - min, 86400000);
  const x = f => ((new Date(f + 'T12:00:00') - min) / span * 100).toFixed(2);
  const xHoy = ((hoy - min) / span * 100).toFixed(2);
  const simultaneos = a.permisos.filter(p => p.situacion === 'ejecucion').length;
  const conRegistro = a.permisos.filter(p => p.registros?.length).length;
  const conPuntos = a.permisos.filter(p => p.puntos.length).length;
  const sup = a.superposiciones || [];
  const filas = ps.map(p => {
    const sit = PRES_SIT.find(s => s.key === p.situacion);
    const barra = p.inicio
      ? `<span class="terr-gantt-bar" style="left:${x(p.inicio)}%;width:${Math.max(1.5, x(p.termino || p.inicio) - x(p.inicio))}%;background:${sit.color}"></span>`
      : '<span class="terr-gantt-sin">en evaluación, sin fechas</span>';
    return `<li><button data-terr-tramite="${p.id}" title="${_esc(p.titulo || '')}">
      <span class="terr-gantt-id">#${p.id}${p.registros?.length ? ' <i title="Tiene registro geográfico">📍</i>' : ''}</span>
      <span class="terr-gantt-pista">${barra}</span></button></li>`;
  }).join('');
  return `
    <p class="terr-resumen"><strong>${_terrPlural(a.activos, 'permiso activo', 'permisos activos')}</strong>
      ${a.km2 ? ` en ${_terrKm2(a.km2)}` : ''}.
      ${simultaneos > 1 ? `<strong class="terr-alerta">${simultaneos} trabajan al mismo tiempo hoy.</strong>` : ''}</p>
    ${sup.length ? `<div class="terr-sup"><strong>${_terrPlural(sup.length, 'posible superposición', 'posibles superposiciones')}</strong>
      entre sitios de distintos permisos: ${sup.slice(0, 6).map(s => `<button data-terr-tramite="${s.a}">#${s.a}</button> y <button data-terr-tramite="${s.b}">#${s.b}</button>`).join('; ')}.
      Conviene coordinar a los equipos.</div>` : ''}
    <h4>Calendario de actividades <small>la línea es hoy</small></h4>
    <ul class="terr-gantt" style="--hoy:${xHoy}">${filas}</ul>
    <div class="terr-gantt-eje"><span>${min.toLocaleDateString('es-CL', { month: 'short', year: 'numeric' })}</span><span>${max.toLocaleDateString('es-CL', { month: 'short', year: 'numeric' })}</span></div>
    <p class="terr-nota">${conRegistro} de ${a.permisos.length} con registro geográfico del titular · ${conPuntos} con coordenadas en el formulario.
      ${a.puntos_fuera ? `${a.puntos_fuera} coordenadas declaradas caen fuera del límite y no se muestran.` : ''}
      Para los que no tienen ubicación, pida el registro desde el detalle del trámite.</p>`;
}

// ─── Mapa ─────────────────────────────────────────────────────────────────────
function _terrPopupPermiso(p) {
  const sit = PRES_SIT.find(s => s.key === p.situacion);
  return `<div class="pres-pop"><strong>#${p.id}</strong> · ${p.tipo === 'inv' ? 'Investigación' : 'Filmación'}<br>
    <span>${sit ? sit.label : ''}</span> · ${_fechaCorta(p.inicio)} – ${_fechaCorta(p.termino)}<br>
    ${p.titulo ? `<em>${_esc(p.titulo)}</em><br>` : ''}<a href="#" data-tramite="${p.id}">Ver detalle del trámite</a></div>`;
}

function _terrDibujar() {
  const L = window.L, mapa = _terrMapa, d = _terr.datos;
  mapa.eachLayer(l => { if (!(l instanceof L.TileLayer)) mapa.removeLayer(l); });
  const capas = L.featureGroup();

  if (d.escala === 'pais') {
    const areas = d.areas.filter(a => a.activos && a.lat !== null);
    const max = Math.max(...areas.map(a => a.activos), 1);
    [...areas].sort((a, b) => b.activos - a.activos).forEach(a => {
      const color = a.ejecucion ? PRES_SIT[0].color : a.programado ? PRES_SIT[1].color : PRES_SIT[2].color;
      L.circleMarker([a.lat, a.lon], { radius: 3 + Math.sqrt(a.activos / max) * 14, color: '#fff', weight: 1, fillColor: color, fillOpacity: .7 })
        .bindTooltip(`<strong>${_esc(a.area)}</strong><br>${_esc(a.region)} · ${_terrPlural(a.activos, 'permiso activo', 'permisos activos')}<br>
          ${PRES_SIT.map(s => `${s.label}: ${a[s.key]}`).join('<br>')}${a.km2 ? `<br>Superficie: ${_terrKm2(a.km2)}` : ''}<br><small>Clic para acercarse</small>`)
        .on('click', () => _terrIrArea(a.area, a.region))
        .addTo(capas);
    });
    capas.addTo(mapa);
    _terrEncuadre = [areas.length ? capas.getBounds().pad(.1) : L.latLngBounds([[-56, -76], [-17.5, -66]]), 6];
    return;
  }

  const areas = _terr.area ? [_terr.area] : d.areas;
  const max = Math.max(...d.areas.map(a => a.activos), 1);
  areas.forEach(a => {
    if (a.limite) {
      const nivel = _terrNivel(a.activos, max);
      L.geoJSON(a.limite, { style: { color: '#013722', weight: _terr.area ? 2.5 : 1.2, fillColor: TERR_ESCALA_COLOR[nivel], fillOpacity: _terr.area ? .12 : .7 } })
        .bindTooltip(`<strong>${_esc(a.area)}</strong><br>${_terrPlural(a.activos, 'permiso activo', 'permisos activos')}${_terr.area ? '' : '<br><small>Clic para acercarse</small>'}`, { sticky: true })
        .on('click', () => { if (!_terr.area) _terrIrArea(a.area); })
        .addTo(capas);
    }
    a.permisos.forEach(p => {
      const sit = PRES_SIT.find(s => s.key === p.situacion);
      if (p.puntos.length >= 3) {
        L.polygon(p.puntos, { color: sit.color, weight: 1.5, fillColor: sit.color, fillOpacity: .08, dashArray: '5 4' })
          .bindPopup(`<div class="pres-pop"><strong>#${p.id}</strong><br>Área declarada en el formulario (${p.puntos.length} coordenadas)<br>
            ${p.titulo ? `<em>${_esc(p.titulo)}</em><br>` : ''}<a href="#" data-tramite="${p.id}">Ver detalle</a></div>`).addTo(capas);
      }
      p.puntos.forEach(([lat, lon]) => L.circleMarker([lat, lon], { radius: _terr.area ? 7 : 5, color: '#fff', weight: 1.5, fillColor: sit.color, fillOpacity: .95 })
        .bindPopup(_terrPopupPermiso(p)).addTo(capas));
      (p.registros || []).forEach(f => L.geoJSON(f, {
        pointToLayer: (_, ll) => L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2, fillColor: TERR_REG.punto, fillOpacity: 1 }),
        style: g => g.geometry.type === 'Point' ? {} : { color: TERR_REG[g.properties.tipo], weight: 2.5, fillOpacity: .25 },
      }).bindPopup(`<div class="pres-pop"><strong>${_esc(f.properties.nombre)}</strong> · #${p.id}<br>
        ${_esc(f.properties.categoria_nombre || '')}${f.properties.metodo ? `<br><em>${_esc(f.properties.metodo.slice(0, 220))}</em>` : ''}<br>
        <a href="#" data-tramite="${p.id}">Ver detalle del trámite</a></div>`).addTo(capas));
    });
  });
  capas.addTo(mapa);
  _terrEncuadre = capas.getLayers().length ? [capas.getBounds().pad(.05), _terr.area ? 14 : 10] : null;
}

// El encuadre se aplica sin animación y se repite cuando el mapa termina de acomodarse:
// si se calcula mientras el contenedor cambia de tamaño o sigue una animación de zoom,
// Leaflet queda en el nivel mundial.
let _terrEncuadre = null;
function _terrEncuadrar() {
  if (!_terrMapa || !_terrEncuadre) return;
  _terrMapa.stop();
  _terrMapa.invalidateSize({ pan: false });
  const [b, max] = _terrEncuadre;
  if (b.isValid()) _terrMapa.fitBounds(b, { maxZoom: max, animate: false });
}

async function _terrPintar() {
  const card = document.getElementById('terr-card');
  if (!card) return;
  card.querySelector('.terr-migas-host').innerHTML = _terrMigas();
  card.querySelector('.terr-lado').innerHTML = _terrLado();
  const cont = card.querySelector('.terr-mapa');
  try { await _cargarLeaflet(); } catch (e) { cont.innerHTML = `<div class="empty-msg">${_esc(e.message)}</div>`; return; }
  if (!_terrMapa || _terrMapa.getContainer() !== cont) {
    if (_terrMapa) _terrMapa.remove();
    _terrMapa = L.map(cont, { scrollWheelZoom: false, zoomSnap: .5 });
    const topo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18, referrerPolicy: 'strict-origin-when-cross-origin', attribution: 'Mapa © Esri, HERE, Garmin, © colaboradores de OpenStreetMap' }).addTo(_terrMapa);
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18, referrerPolicy: 'strict-origin-when-cross-origin', attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics' });
    L.control.layers({ 'Topográfico': topo, 'Satélite': sat }, null, { position: 'topright' }).addTo(_terrMapa);
    _terrMapa.setView([-38, -71], 4);
    // si el mapa se dibujó oculto (otra pestaña) o cambió de tamaño, se vuelve a encuadrar
    let ancho = cont.clientWidth;
    new ResizeObserver(() => {
      if (cont.clientWidth && cont.clientWidth !== ancho) { ancho = cont.clientWidth; _terrEncuadrar(); }
    }).observe(cont);
  }
  _terrEncuadre = null;
  _terrDibujar();
  _terrEncuadrar();
  requestAnimationFrame(_terrEncuadrar);
  setTimeout(_terrEncuadrar, 250);
}

// ─── Navegación entre escalas ─────────────────────────────────────────────────
// El área elegida en el mapa es el ámbito de TODO el Resumen (app.js: setAmbito), no solo del mapa
function _terrIrArea(nombre, region) {
  setAmbito(region || STATE.region, nombre);
  document.getElementById('filtro-regiones')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

const _terrBuscarArea = (d, nombre) => !nombre || !d || d.escala !== 'region' ? null
  : d.areas.find(a => a.area === nombre) || d.areas.find(a => areaCoincide(a.area, nombre)) || null;

async function renderTerritorio(region, tipo, area = null) {
  const host = document.getElementById('territorio');
  if (!host) return;
  const cambio = region !== _terr.region || tipo !== _terr.tipo;
  _terr = { ..._terr, region, tipo, areaNombre: area };
  if (!host.querySelector('#terr-card')) {
    host.innerHTML = `<section class="pano-card terr-card" id="terr-card">
      <header class="pano-head"><div><h3>Dónde se concentran los permisos</h3>
        <p>Permisos activos: en ejecución hoy, programados y en evaluación (últimos 3 años) · clic en una región o área para acercarse</p></div>
        <div class="terr-migas-host"></div></header>
      <div class="terr-cuerpo"><div class="terr-mapa" role="region" aria-label="Mapa de permisos activos"></div><div class="terr-lado"></div></div>
    </section>`;
    host.addEventListener('click', _terrClic);
  }
  if (!cambio && _terr.datos) {            // solo cambió el área: se acerca sin volver a consultar
    _terr.area = _terrBuscarArea(_terr.datos, area);
    _terrPintar();
    return;
  }
  host.querySelector('.terr-lado').innerHTML = '<div class="empty-msg">⏳ Calculando… (la primera vez puede tardar hasta un minuto)</div>';
  let d;
  try { d = await _terrDatos(tipo, region); }
  catch (e) { host.querySelector('.terr-lado').innerHTML = `<div class="empty-msg">No se pudo calcular (${_esc(e.message)}).</div>`; return; }
  if (_terr.region !== region || _terr.tipo !== tipo) return;   // cambió mientras cargaba
  _terr.datos = d;
  _terr.area = _terrBuscarArea(d, _terr.areaNombre);
  _terrPintar();
}

function _terrClic(e) {
  const det = e.target.closest('[data-tramite], [data-terr-tramite]');
  if (det) {
    e.preventDefault();
    _terrMapa?.closePopup();
    openModal(Number(det.dataset.tramite || det.dataset.terrTramite));
    return;
  }
  const ir = e.target.closest('[data-terr-ir]');
  if (ir) {
    if (ir.dataset.terrIr === 'pais') setAmbito(null);
    else setArea(null);
    return;
  }
  const area = e.target.closest('[data-terr-area]');
  if (area) _terrIrArea(area.dataset.terrArea, area.dataset.terrRegion);
}

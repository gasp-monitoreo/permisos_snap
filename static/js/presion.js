/* ═══════════════════════════════════════════════
   Resumen · Presión sobre áreas protegidas de la región filtrada
   y mapa de ubicación de las actividades al elegir un área.
   Datos: /api/presion?region=… (tramites/presion.py)
   Mapa: Leaflet + teselas de OpenStreetMap (se cargan solo al abrir un mapa).
   Usa de panorama.js: _card, _tablaHtml, _esc, _fmt.
   ═══════════════════════════════════════════════ */
'use strict';

const PRES_SIT = [
  { key: 'ejecucion',  label: 'En ejecución hoy',     color: '#1D4D0B' },
  { key: 'programado', label: 'Programados',          color: '#6EAA4B' },
  { key: 'evaluacion', label: 'En evaluación',        color: '#D9A13B' },
];
const _presCache = new Map();          // 'tipo|región' → datos (memoria de la sesión)
const _subtituloTipo = tipo => `Permisos activos hoy · ${tipo === 'film' ? 'filmación y fotografía' : 'investigación'}`;
let _presMapa = null;
let _leafletListo = null;

function _cargarLeaflet() {
  if (window.L) return Promise.resolve();
  if (_leafletListo) return _leafletListo;
  _leafletListo = new Promise((ok, mal) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    js.onload = ok;
    js.onerror = () => mal(new Error('No se pudo cargar el mapa'));
    document.head.appendChild(js);
  });
  return _leafletListo;
}

const _fechaCorta = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' }) : '–';

function _presionHtml(region, areas, tipo) {
  if (!areas.length) {
    return _card('res-presion', `Presión sobre áreas protegidas · ${_esc(region)}`,
      _subtituloTipo(tipo), '<div class="empty-msg">No hay permisos activos ni en evaluación en áreas protegidas de esta región.</div>', '');
  }
  const max = Math.max(...areas.map(a => a.activos), 1);
  const filas = areas.map((a, i) => {
    const tip = `<strong>${_esc(a.area)}</strong><br>${PRES_SIT.map(s => `${s.label}: ${a[s.key]}`).join('<br>')}<br><small>Clic para ver el mapa</small>`;
    return `<div class="pres-row" data-area="${i}" data-tip="${_esc(tip)}" tabindex="0" role="button" aria-expanded="false">
      <span class="pres-nom">${_esc(a.area)}</span>
      <span class="pres-bar">${PRES_SIT.map(s => a[s.key] ? `<span class="seg" style="width:${a[s.key] / max * 100}%;background:${s.color}"></span>` : '').join('')}<em>${a.activos}</em></span>
    </div>`;
  }).join('');
  const top = areas[0];
  const cuerpo = `<div class="pano-legend">${PRES_SIT.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div>
    <div class="pres-rows">${filas}</div>
    <div class="pres-mapa-wrap" hidden>
      <div class="pres-mapa-head"><strong></strong><span></span><button class="pres-cerrar" aria-label="Cerrar mapa">✕</button></div>
      <div class="pres-mapa" id="pres-mapa"></div>
      <div class="pres-mapa-leyenda">
        ${PRES_SIT.map(s => `<span><i class="pm" style="background:${s.color}"></i>${s.label}</span>`).join('')}
        <span><i class="pm limite"></i>Límite oficial del área (SNAP, CONAF nov. 2025)</span>
        <span>Puntos: coordenadas declaradas en el formulario que caen dentro del área</span>
      </div>
    </div>
    <p class="pano-nota">Mayor presión: ${_esc(top.area)} con ${top.ejecucion} permiso${top.ejecucion === 1 ? '' : 's'} en ejecución hoy.
      Considera trámites de los últimos 3 años cuyo período de actividades incluye hoy, los que aún no comienzan y los que están en evaluación.
      Haz clic en un área para ver el mapa.</p>`;
  const tabla = _tablaHtml(['Área protegida', 'En ejecución', 'Programados', 'En evaluación'],
    areas.map(a => [a.area, a.ejecucion, a.programado, a.evaluacion]));
  return _card('res-presion', `Presión sobre áreas protegidas · ${_esc(region)}`,
    _subtituloTipo(tipo), cuerpo, tabla);
}

async function _abrirMapa(card, area, fila) {
  const wrap = card.querySelector('.pres-mapa-wrap');
  card.querySelectorAll('.pres-row').forEach(r => { r.classList.toggle('activa', r === fila); r.setAttribute('aria-expanded', r === fila); });
  wrap.hidden = false;
  const conPuntos = area.permisos.filter(p => p.puntos.length);
  wrap.querySelector('.pres-mapa-head strong').textContent = area.area;
  const fuera = area.puntos_fuera
    ? ` · ${area.puntos_fuera} coordenada${area.puntos_fuera === 1 ? '' : 's'} fuera del límite (no se muestra${area.puntos_fuera === 1 ? '' : 'n'})` : '';
  wrap.querySelector('.pres-mapa-head span').textContent = area.limite
    ? `${area.permisos.length} permisos · ${conPuntos.length} con coordenadas dentro del área${fuera}`
    : `${area.permisos.length} permisos · ${conPuntos.length} con coordenadas · sin límite oficial para verificarlas`;
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (_presMapa) { _presMapa.remove(); _presMapa = null; }
  // Se dibuja el límite oficial y las coordenadas declaradas que caen dentro de él
  const contenedor = wrap.querySelector('.pres-mapa');
  if (!conPuntos.length && !area.limite) {
    contenedor.classList.add('vacio');
    contenedor.innerHTML = '<div class="empty-msg">Ninguno de estos permisos declaró coordenadas en el formulario.</div>';
    return;
  }
  contenedor.classList.remove('vacio');
  contenedor.innerHTML = '';
  try { await _cargarLeaflet(); } catch (e) {
    contenedor.innerHTML = `<div class="empty-msg">${_esc(e.message)}</div>`;
    return;
  }
  const L = window.L;
  const mapa = L.map(contenedor, { scrollWheelZoom: false });
  _presMapa = mapa;
  // Teselas Esri (topográfico y satélite), sin clave de API. Las de tile.openstreetmap.org
  // bloquean peticiones sin Referer (que Django omite por defecto) y CARTO exige clave.
  const base = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, referrerPolicy: 'strict-origin-when-cross-origin',
    attribution: 'Mapa © Esri, HERE, Garmin, © colaboradores de OpenStreetMap',
  }).addTo(mapa);
  const satelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, referrerPolicy: 'strict-origin-when-cross-origin',
    attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics',
  });
  L.control.layers({ 'Topográfico': base, 'Satélite': satelite }, null, { position: 'topright' }).addTo(mapa);

  const color = s => (PRES_SIT.find(x => x.key === s) || PRES_SIT[0]).color;
  // Las capas se crean primero y se agregan después de fijar el encuadre:
  // Leaflet no puede dibujar vectores en un mapa que aún no tiene vista.
  const contorno = area.limite ? L.geoJSON(area.limite, {
    style: { color: '#013722', weight: 2, fillColor: '#4A9324', fillOpacity: .12 },
    interactive: false,
  }) : null;
  const capas = [];
  conPuntos.forEach(p => {
    const sit = PRES_SIT.find(x => x.key === p.situacion);
    const popup = `<div class="pres-pop"><strong>#${p.id}</strong> · ${p.tipo === 'inv' ? 'Investigación' : 'Filmación'}<br>
      <span>${sit ? sit.label : ''}</span> · ${_fechaCorta(p.inicio)} – ${_fechaCorta(p.termino)}<br>
      ${p.titulo ? `<em>${_esc(p.titulo)}</em><br>` : ''}
      <a href="#" data-tramite="${p.id}">Ver detalle del trámite</a></div>`;
    p.puntos.forEach(([lat, lon]) => capas.push(L.circleMarker([lat, lon], {
      radius: 7, color: '#fff', weight: 2, fillColor: color(p.situacion), fillOpacity: .95,
    }).bindPopup(popup)));
  });
  // Encuadre: el límite del área (o, sin límite, los puntos)
  const marco = contorno ? contorno.getBounds() : L.featureGroup(capas).getBounds();
  mapa.fitBounds(marco.pad(0.08), { maxZoom: 13 });
  if (contorno) contorno.addTo(mapa);
  capas.forEach(c => c.addTo(mapa));
  if (!conPuntos.length) {
    const aviso = L.control({ position: 'bottomleft' });
    aviso.onAdd = () => Object.assign(document.createElement('div'), {
      className: 'pres-aviso', textContent: 'Ningún permiso declaró coordenadas dentro de esta área.',
    });
    aviso.addTo(mapa);
  }
  setTimeout(() => mapa.invalidateSize(), 50);
}

async function renderPresion(region, tipo) {
  const host = document.getElementById('res-presion-host');
  if (!host) return;
  if (!region) { host.innerHTML = ''; return; }
  host.innerHTML = _card('res-presion', `Presión sobre áreas protegidas · ${_esc(region)}`, _subtituloTipo(tipo),
    '<div class="empty-msg">⏳ Calculando la presión sobre las áreas protegidas… (la primera vez puede tardar hasta un minuto)</div>', '');
  const clave = `${tipo}|${region}`;
  let areas = _presCache.get(clave);
  if (!areas) {
    try {
      const r = await fetch(`/api/presion?region=${encodeURIComponent(region)}&tipo=${encodeURIComponent(tipo)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'error');
      areas = j.data;
      _presCache.set(clave, areas);
    } catch (e) {
      host.innerHTML = _card('res-presion', `Presión sobre áreas protegidas · ${_esc(region)}`, '',
        `<div class="empty-msg">No se pudo calcular la presión (${_esc(e.message)}).</div>`, '');
      return;
    }
  }
  if (STATE.region !== region || STATE.tipo !== tipo) return;   // cambió de región o sección mientras cargaba
  if (_presMapa) { _presMapa.remove(); _presMapa = null; }
  host.innerHTML = _presionHtml(region, areas, tipo);
  const card = host.querySelector('#res-presion');
  const elegir = fila => _abrirMapa(card, areas[Number(fila.dataset.area)], fila);
  card.addEventListener('click', e => {
    const det = e.target.closest('[data-tramite]');
    if (det) {
      e.preventDefault();
      if (_presMapa) _presMapa.closePopup();
      openModal(Number(det.dataset.tramite));
      return;
    }
    if (e.target.closest('.pres-cerrar')) {
      card.querySelector('.pres-mapa-wrap').hidden = true;
      card.querySelectorAll('.pres-row').forEach(r => { r.classList.remove('activa'); r.setAttribute('aria-expanded', 'false'); });
      return;
    }
    const fila = e.target.closest('.pres-row');
    if (fila) elegir(fila);
  });
  card.addEventListener('keydown', e => {
    const fila = e.target.closest('.pres-row');
    if (fila && e.key === 'Enter') elegir(fila);
  });
}

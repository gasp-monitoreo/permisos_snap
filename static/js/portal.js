/* ═══════════════════════════════════════════════
   Portal del investigador: registro geográfico del permiso.
   Panel lateral con cuatro vistas (lista, dibujo, formulario, importar/coordenadas)
   y un mapa Leaflet. Datos: /portal/api/… (tramites/portal.py), GeoJSON WGS84.
   ═══════════════════════════════════════════════ */
'use strict';
(() => {
  const D = JSON.parse(document.getElementById('pt-datos').textContent);
  const CAT = D.categorias;
  const TIPOS = {
    punto:    { nombre: 'Punto',     verbo: 'un punto',     min: 1, color: '#B9412F', icono: '<circle cx="12" cy="11" r="3"/><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/>' },
    linea:    { nombre: 'Transecto', verbo: 'un transecto', min: 2, color: '#0155A0', icono: '<path d="M4 18 10 9l4 5 6-9"/><circle cx="4" cy="18" r="1.6"/><circle cx="20" cy="5" r="1.6"/>' },
    poligono: { nombre: 'Parcela',   verbo: 'una parcela',  min: 3, color: '#347A17', icono: '<path d="M5 7l7-3 7 4-1 10-9 2-4-6z"/>' },
  };
  const GEO = { punto: 'Point', linea: 'LineString', poligono: 'Polygon' };
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = t => `<svg viewBox="0 0 24 24" aria-hidden="true">${TIPOS[t].icono}</svg>`;
  const panel = $('pt-panel');

  let registros = [];           // features guardadas
  let capas = new Map();        // id → capa Leaflet
  let dibujo = null;            // { tipo, puntos: [[lat,lon]], capa, vertices, editando }
  let importados = null;        // { archivo, elementos, avisos }

  // ─── API ───────────────────────────────────────────────────────────────────
  async function api(url, opciones = {}) {
    const r = await fetch(url, opciones);
    const datos = (r.headers.get('Content-Type') || '').includes('json') ? await r.json() : null;
    if (r.status === 401 || r.redirected) { location.href = '/portal/ingresar?vencido=1'; throw new Error('Sesión vencida'); }
    if (!r.ok || !datos || datos.ok === false) throw new Error(datos?.error || `Error ${r.status}`);
    return datos;
  }
  const enviar = (url, cuerpo) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

  // ─── Mapa ──────────────────────────────────────────────────────────────────
  const mapa = L.map('pt-mapa', { zoomControl: true, doubleClickZoom: true });
  const topo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: 'Mapa © Esri, HERE, Garmin, © colaboradores de OpenStreetMap' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics' }).addTo(mapa);
  L.control.layers({ 'Satélite': sat, 'Topográfico': topo }, null, { position: 'topright' }).addTo(mapa);
  L.control.scale({ imperial: false }).addTo(mapa);

  const capaAreas = L.geoJSON(D.areas, {
    style: { color: '#F2C14E', weight: 2.5, dashArray: '6 5', fillColor: '#F2C14E', fillOpacity: .06 },
    interactive: false,
  }).addTo(mapa);
  const capaRegistros = L.featureGroup().addTo(mapa);
  const capaVista = L.featureGroup().addTo(mapa);     // vista previa de importación o coordenadas

  function encuadrar() {
    const b = capaRegistros.getLayers().length ? capaRegistros.getBounds()
      : capaAreas.getLayers().length ? capaAreas.getBounds() : null;
    if (b && b.isValid()) mapa.fitBounds(b, { padding: [30, 30], maxZoom: 15 });
    else mapa.setView([-38.5, -72], 5);
  }

  function capaDe(f, opciones = {}) {
    const t = f.properties?.tipo || { Point: 'punto', LineString: 'linea', Polygon: 'poligono' }[f.geometry.type];
    const color = opciones.color || TIPOS[t].color;
    return L.geoJSON(f, {
      pointToLayer: (_, ll) => L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }),
      // el estilo de líneas y polígonos no debe aplicarse a los puntos (quedarían huecos)
      style: g => g.geometry.type === 'Point' ? {} : { color, weight: 3, fillColor: color, fillOpacity: .18, dashArray: opciones.dash },
    });
  }

  function pintarRegistros() {
    capaRegistros.clearLayers();
    capas = new Map();
    registros.forEach(f => {
      const c = capaDe(f);
      c.bindTooltip(esc(f.properties.nombre), { sticky: true });
      c.on('click', () => { if (!dibujo) editar(f.properties.id); });
      c.addTo(capaRegistros);
      capas.set(f.properties.id, c);
    });
  }

  function resaltar(id) {
    capas.forEach((c, k) => c.eachLayer(l => {
      const punto = l instanceof L.CircleMarker;
      l.setStyle({ weight: punto ? (k === id ? 4 : 2) : (k === id ? 5 : 3), opacity: !id || k === id ? 1 : .55,
        ...(punto ? { radius: k === id ? 10 : 7, fillOpacity: !id || k === id ? 1 : .55 } : {}) });
    }));
  }

  // ─── Vista: lista ──────────────────────────────────────────────────────────
  function vistaLista() {
    dibujo = null; importados = null; enFormulario = null;
    capaVista.clearLayers(); resaltar(null);
    mapa.getContainer().classList.remove('pt-dibujando');
    const acc = D.acceso;
    const filas = registros.map(f => {
      const p = f.properties;
      return `<li><button class="pt-reg" data-id="${p.id}">
        <span class="pt-reg-ico pt-${p.tipo}">${svg(p.tipo)}</span>
        <span class="pt-reg-txt"><strong>${esc(p.nombre)}</strong>
        <small>${esc(p.categoria_nombre || TIPOS[p.tipo].nombre)}${p.fecha_inicio ? ` · ${p.fecha_inicio}` : ''}</small></span>
      </button></li>`;
    }).join('');
    panel.innerHTML = `
      <section class="pt-intro">
        <h1>Registre dónde trabaja</h1>
        <p>Marque en el mapa los puntos de muestreo, transectos y parcelas de su permiso${acc.areas.length ? ` en <strong>${esc(acc.areas.join(', '))}</strong>` : ''}, con el método y los datos de cada uno. Este registro queda asociado al permiso y ayuda a CONAF a gestionar el área.</p>
      </section>
      <section class="pt-acciones">
        <h2>Agregar en el mapa</h2>
        <div class="pt-tipos">${Object.keys(TIPOS).map(t => `<button class="pt-tipo" data-dibujar="${t}">${svg(t)}<span>${TIPOS[t].nombre}</span></button>`).join('')}</div>
        <div class="pt-otras">
          <button class="pt-btn pt-btn--suave" data-vista="coordenadas">Escribir coordenadas</button>
          <button class="pt-btn pt-btn--suave" data-vista="importar">Importar archivo GPS/SIG</button>
        </div>
      </section>
      <section class="pt-lista">
        <h2>Sus registros <span>${registros.length}</span></h2>
        ${registros.length ? `<ul>${filas}</ul>` : '<p class="pt-vacio">Aún no hay registros. Empiece agregando un punto, un transecto o una parcela.</p>'}
      </section>
      ${registros.length ? '<a class="pt-descargar" href="/portal/api/descargar">Descargar mis registros (GeoJSON)</a>' : ''}`;
  }

  // ─── Vista: dibujo ─────────────────────────────────────────────────────────
  function iniciarDibujo(tipo, editando = null) {
    capaVista.clearLayers();
    dibujo = { tipo, puntos: [], editando };
    mapa.doubleClickZoom.disable();
    mapa.getContainer().classList.add('pt-dibujando');
    dibujo.capa = (tipo === 'poligono' ? L.polygon([], { color: TIPOS[tipo].color, weight: 3, fillOpacity: .15 })
      : L.polyline([], { color: TIPOS[tipo].color, weight: 3, dashArray: '6 4' })).addTo(capaVista);
    vistaDibujo();
  }

  function vistaDibujo() {
    const t = TIPOS[dibujo.tipo], n = dibujo.puntos.length;
    const falta = Math.max(0, t.min - n);
    panel.innerHTML = `
      <section class="pt-intro">
        <h1>${dibujo.editando ? 'Redibujar' : 'Agregar'} ${t.verbo}</h1>
        <p>${dibujo.tipo === 'punto' ? 'Haga clic en el mapa donde está el punto.'
          : `Haga clic en el mapa para marcar cada vértice${dibujo.tipo === 'poligono' ? ' del contorno' : ' del recorrido'}. Doble clic o «Terminar» para cerrar.`}</p>
        <p class="pt-nota">Consejo: cambie a la vista «Satélite» (arriba a la derecha) y acérquese para mayor precisión.</p>
      </section>
      ${dibujo.tipo !== 'punto' ? `<p class="pt-contador">${n} vértice${n === 1 ? '' : 's'}${falta ? ` · faltan ${falta}` : ''}</p>` : ''}
      <div class="pt-botonera">
        ${dibujo.tipo !== 'punto' ? `<button class="pt-btn" data-accion="terminar" ${falta ? 'aria-disabled="true"' : ''}>Terminar</button>
        <button class="pt-btn pt-btn--suave" data-accion="deshacer" ${n ? '' : 'aria-disabled="true"'}>Deshacer vértice</button>` : ''}
        <button class="pt-btn pt-btn--suave" data-accion="cancelar">Cancelar</button>
      </div>`;
  }

  function redibujar() {
    dibujo.capa.setLatLngs(dibujo.puntos);
    if (dibujo.vertices) capaVista.removeLayer(dibujo.vertices);
    dibujo.vertices = L.featureGroup(dibujo.puntos.map(p => L.circleMarker(p, { radius: 4, color: TIPOS[dibujo.tipo].color, fillColor: '#fff', fillOpacity: 1, weight: 2 }))).addTo(capaVista);
    vistaDibujo();
  }

  function terminarDibujo() {
    const t = TIPOS[dibujo.tipo];
    if (dibujo.puntos.length < t.min) return;
    const lonlat = dibujo.puntos.map(([la, lo]) => [lo, la]);
    const geom = dibujo.tipo === 'punto' ? { type: 'Point', coordinates: lonlat[0] }
      : dibujo.tipo === 'linea' ? { type: 'LineString', coordinates: lonlat }
      : { type: 'Polygon', coordinates: [[...lonlat, lonlat[0]]] };
    const editando = dibujo.editando;
    mapa.doubleClickZoom.enable();
    mapa.getContainer().classList.remove('pt-dibujando');
    dibujo = null;
    vistaFormulario(editando ? { ...editando, geometry: geom } : { geometry: geom, properties: { tipo: Object.keys(GEO).find(k => GEO[k] === geom.type), origen: 'mapa' } });
  }

  mapa.on('click', e => {
    if (!dibujo) return;
    dibujo.puntos.push([e.latlng.lat, e.latlng.lng]);
    if (dibujo.tipo === 'punto') return terminarDibujo();
    redibujar();
  });
  mapa.on('dblclick', e => {
    if (!dibujo || dibujo.tipo === 'punto') return;
    L.DomEvent.stop(e);
    // el doble clic agrega dos vértices iguales al final: se descarta el repetido
    const p = dibujo.puntos, a = p[p.length - 1], b = p[p.length - 2];
    if (a && b && a[0] === b[0] && a[1] === b[1]) p.pop();
    terminarDibujo();
  });

  // ─── Vista: formulario de metadatos ────────────────────────────────────────
  let enFormulario = null;   // feature que se está editando (puede no estar guardada)

  function vistaFormulario(f) {
    f = { ...f, type: 'Feature' };   // Leaflet exige Feature completo
    enFormulario = f;
    const p = f.properties || {};
    const tipo = { Point: 'punto', LineString: 'linea', Polygon: 'poligono' }[f.geometry.type];
    capaVista.clearLayers();
    if (!p.id) capaDe(f, { dash: '6 4' }).addTo(capaVista);
    resaltar(p.id || null);
    const b = L.geoJSON(f).getBounds();
    if (b.isValid()) mapa.fitBounds(b, { padding: [60, 60], maxZoom: 17 });
    const atributos = Object.entries(p.atributos || {});
    const c = f.geometry.coordinates;
    const resumen = tipo === 'punto' ? '' : tipo === 'linea' ? `${c.length} vértices · ${longitud(c)}` : `${c[0].length - 1} vértices · ${superficie(c[0])}`;
    panel.innerHTML = `
      <form class="pt-form" id="pt-form" novalidate>
        <header class="pt-form-head">
          <span class="pt-reg-ico pt-${tipo}">${svg(tipo)}</span>
          <div><h1>${p.id ? 'Editar' : 'Nuevo'}: ${TIPOS[tipo].nombre.toLowerCase()}</h1>${resumen ? `<small>${resumen}</small>` : ''}</div>
        </header>
        ${tipo === 'punto' ? `<div class="pt-fila2">
          <label>Latitud<input name="lat" inputmode="decimal" value="${c[1]}"></label>
          <label>Longitud<input name="lon" inputmode="decimal" value="${c[0]}"></label>
        </div>` : ''}
        <label><span>Nombre o código <span class="pt-oblig">*</span></span><input name="nombre" required maxlength="200" value="${esc(p.nombre || '')}" placeholder="Ej.: Parcela P-03, Cámara 12"></label>
        <label>Categoría<select name="categoria"><option value="">Sin categoría</option>
          ${Object.entries(CAT).map(([k, v]) => `<option value="${k}" ${p.categoria === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label>Método<textarea name="metodo" rows="3" maxlength="5000" placeholder="Ej.: parcela de 20 × 20 m, conteo de individuos y DAP; cámaras a 40 cm del suelo…">${esc(p.metodo || '')}</textarea></label>
        <label>Descripción<textarea name="descripcion" rows="2" maxlength="5000" placeholder="Qué se hace en este sitio, hallazgos, observaciones">${esc(p.descripcion || '')}</textarea></label>
        <div class="pt-fila2">
          <label>Desde<input type="date" name="fecha_inicio" value="${p.fecha_inicio || ''}"></label>
          <label>Hasta<input type="date" name="fecha_fin" value="${p.fecha_fin || ''}"></label>
        </div>
        <fieldset class="pt-atributos">
          <legend>Otros datos <small>especie objetivo, altitud, tipo de vegetación, n.º de muestras…</small></legend>
          <div id="pt-attr">${atributos.map(([k, v]) => filaAtributo(k, v)).join('')}</div>
          <button type="button" class="pt-link" data-accion="attr">+ Agregar dato</button>
        </fieldset>
        <p class="pt-error" id="pt-error" role="alert" hidden></p>
        <div class="pt-botonera">
          <button class="pt-btn" type="submit">Guardar</button>
          <button class="pt-btn pt-btn--suave" type="button" data-accion="volver">Cancelar</button>
          ${tipo !== 'punto' ? `<button class="pt-link" type="button" data-accion="redibujar">Redibujar en el mapa</button>` : ''}
          ${p.id ? '<button class="pt-link pt-peligro" type="button" data-accion="borrar">Eliminar</button>' : ''}
        </div>
      </form>`;
    panel.querySelector('[name=nombre]').focus();
  }

  const filaAtributo = (k = '', v = '') => `<div class="pt-attr-fila">
    <input name="attr_k" placeholder="Dato" maxlength="60" value="${esc(k)}" aria-label="Nombre del dato">
    <input name="attr_v" placeholder="Valor" maxlength="500" value="${esc(v)}" aria-label="Valor">
    <button type="button" class="pt-x" data-accion="attr-quitar" aria-label="Quitar dato">✕</button></div>`;

  function leerFormulario() {
    const fm = $('pt-form'), v = n => fm.elements[n]?.value.trim() || '';
    let geom = enFormulario.geometry;
    if (geom.type === 'Point') {
      const lat = parseFloat(v('lat').replace(',', '.')), lon = parseFloat(v('lon').replace(',', '.'));
      if (!isFinite(lat) || !isFinite(lon)) throw new Error('Revise la latitud y la longitud.');
      geom = { type: 'Point', coordinates: [lon, lat] };
    }
    const atributos = {};
    fm.querySelectorAll('.pt-attr-fila').forEach(r => {
      const k = r.querySelector('[name=attr_k]').value.trim(), val = r.querySelector('[name=attr_v]').value.trim();
      if (k) atributos[k] = val;
    });
    if (!v('nombre')) throw new Error('Escriba un nombre o código para el registro.');
    return { geometria: geom, nombre: v('nombre'), categoria: v('categoria'), metodo: v('metodo'), descripcion: v('descripcion'),
      fecha_inicio: v('fecha_inicio') || null, fecha_fin: v('fecha_fin') || null, atributos, origen: enFormulario.properties?.origen || 'mapa' };
  }

  async function guardar() {
    const err = $('pt-error');
    err.hidden = true;
    try {
      const datos = leerFormulario();
      const id = enFormulario.properties?.id;
      const r = id ? await enviar(`/portal/api/registros/${id}`, datos) : await enviar('/portal/api/registros/crear', datos);
      const f = id ? r.feature : r.features[0];
      registros = id ? registros.map(x => x.properties.id === id ? f : x) : [...registros, f];
      pintarRegistros();
      vistaLista();
      aviso(id ? 'Cambios guardados' : 'Registro guardado');
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    }
  }

  function editar(id) {
    marcarPestana('registro');
    const f = registros.find(x => x.properties.id === id);
    if (f) vistaFormulario(f);
  }

  async function borrar() {
    const p = enFormulario.properties;
    if (!confirm(`¿Eliminar «${p.nombre}»? Esta acción no se puede deshacer.`)) return;
    try {
      await enviar(`/portal/api/registros/${p.id}/borrar`, {});
      registros = registros.filter(x => x.properties.id !== p.id);
      pintarRegistros(); vistaLista(); aviso('Registro eliminado');
    } catch (e) { aviso(e.message, true); }
  }

  // ─── Vista: escribir coordenadas ───────────────────────────────────────────
  function vistaCoordenadas() {
    capaVista.clearLayers();
    panel.innerHTML = `
      <form class="pt-form" id="pt-coord" novalidate>
        <header class="pt-form-head"><div><h1>Escribir coordenadas</h1><small>Un vértice por línea, en orden.</small></div></header>
        <label>Qué es<select name="tipo">${Object.keys(TIPOS).map(t => `<option value="${t}">${TIPOS[t].nombre}</option>`).join('')}</select></label>
        <label>Formato<select name="formato">
          <option value="dec">Grados decimales: latitud, longitud (ej. -39.2731, -71.9415)</option>
          <option value="utm18">UTM huso 18 sur: este norte (ej. 673000 5652100)</option>
          <option value="utm19">UTM huso 19 sur: este norte</option></select></label>
        <label>Coordenadas<textarea name="texto" rows="7" placeholder="-39.2731, -71.9415&#10;-39.2745, -71.9398" spellcheck="false"></textarea></label>
        <p class="pt-error" id="pt-error" role="alert" hidden></p>
        <div class="pt-botonera">
          <button class="pt-btn" type="submit">Ver en el mapa y continuar</button>
          <button class="pt-btn pt-btn--suave" type="button" data-accion="volver">Cancelar</button>
        </div>
      </form>`;
  }

  // UTM sur (WGS84) → [lat, lon]
  function utmALatLon(e, n, huso) {
    const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    const x = e - 500000, y = n - 10000000, m = y / k0;
    const mu = m / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
    const n1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), t1 = Math.tan(p1) ** 2, c1 = ep2 * Math.cos(p1) ** 2;
    const r1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, d = x / (n1 * k0);
    const lat = p1 - (n1 * Math.tan(p1) / r1) * (d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24
      + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720);
    const lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120) / Math.cos(p1);
    return [lat * 180 / Math.PI, (huso - 1) * 6 - 180 + 3 + lon * 180 / Math.PI];
  }

  function desdeCoordenadas() {
    const fm = $('pt-coord'), err = $('pt-error');
    const tipo = fm.elements.tipo.value, formato = fm.elements.formato.value;
    const lineas = fm.elements.texto.value.split('\n').map(s => s.trim()).filter(Boolean);
    try {
      const pts = lineas.map((l, i) => {
        const nums = (l.match(/-?\d+(?:[.,]\d+)?/g) || []).map(x => parseFloat(x.replace(',', '.')));
        if (nums.length < 2) throw new Error(`Línea ${i + 1}: se esperaban dos números.`);
        let [la, lo] = formato === 'dec' ? nums : utmALatLon(nums[0], nums[1], formato === 'utm18' ? 18 : 19);
        if (formato === 'dec' && la > 0 && lo > 0) { la = -la; lo = -lo; }
        if (formato === 'dec' && Math.abs(la) > Math.abs(lo)) [la, lo] = [lo, la];   // vienen como lon, lat
        if (!(la <= -17 && la >= -60 && lo <= -66 && lo >= -110)) throw new Error(`Línea ${i + 1}: la coordenada queda fuera de Chile.`);
        return [lo, la];
      });
      if (pts.length < TIPOS[tipo].min) throw new Error(`${TIPOS[tipo].nombre}: se necesitan al menos ${TIPOS[tipo].min} coordenadas.`);
      const geom = tipo === 'punto' ? { type: 'Point', coordinates: pts[0] }
        : tipo === 'linea' ? { type: 'LineString', coordinates: pts } : { type: 'Polygon', coordinates: [[...pts, pts[0]]] };
      vistaFormulario({ geometry: geom, properties: { tipo, origen: 'coordenadas' } });
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  }

  // ─── Vista: importar archivo ───────────────────────────────────────────────
  function vistaImportar() {
    capaVista.clearLayers();
    panel.innerHTML = `
      <form class="pt-form" id="pt-imp" novalidate>
        <header class="pt-form-head"><div><h1>Importar archivo GPS/SIG</h1>
          <small>GeoJSON, KML/KMZ (Google Earth), GPX (GPS), CSV o Shapefile comprimido en .zip. Máx. 10 MB.</small></div></header>
        <label class="pt-archivo">Archivo<input type="file" name="archivo" accept=".geojson,.json,.kml,.kmz,.gpx,.csv,.txt,.zip" required></label>
        <label>Si el CSV viene en UTM sin columna de huso<select name="huso"><option value="">Huso 19 sur (por defecto)</option><option value="18">Huso 18 sur</option><option value="19">Huso 19 sur</option></select></label>
        <p class="pt-nota">CSV: columnas «latitud» y «longitud», o «este» y «norte». Las demás columnas se guardan como datos de cada punto.</p>
        <p class="pt-error" id="pt-error" role="alert" hidden></p>
        <div class="pt-botonera">
          <button class="pt-btn" type="submit">Leer archivo</button>
          <button class="pt-btn pt-btn--suave" type="button" data-accion="volver">Cancelar</button>
        </div>
      </form>`;
  }

  async function leerArchivo() {
    const fm = $('pt-imp'), err = $('pt-error'), btn = fm.querySelector('[type=submit]');
    if (!fm.elements.archivo.files.length) { err.textContent = 'Elija un archivo.'; err.hidden = false; return; }
    const datos = new FormData(fm);
    btn.textContent = 'Leyendo…'; btn.setAttribute('aria-disabled', 'true');
    try {
      importados = await api('/portal/api/importar', { method: 'POST', body: datos });
      vistaRevisarImportacion();
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      btn.textContent = 'Leer archivo'; btn.removeAttribute('aria-disabled');
    }
  }

  function vistaRevisarImportacion() {
    const { elementos, avisos, archivo } = importados;
    capaVista.clearLayers();
    elementos.forEach(el => capaDe({ type: 'Feature', geometry: el.geometry, properties: { tipo: el.tipo } }, { dash: '5 4' }).addTo(capaVista));
    const b = capaVista.getBounds();
    if (b.isValid()) mapa.fitBounds(b, { padding: [40, 40], maxZoom: 16 });
    const cuenta = t => elementos.filter(e => e.tipo === t).length;
    panel.innerHTML = `
      <form class="pt-form" id="pt-imp2" novalidate>
        <header class="pt-form-head"><div><h1>Revise lo importado</h1>
          <small>${esc(archivo)}: ${Object.keys(TIPOS).filter(cuenta).map(t => `${cuenta(t)} ${TIPOS[t].nombre.toLowerCase()}${cuenta(t) === 1 ? '' : 's'}`).join(', ')}</small></div></header>
        ${avisos.length ? `<details class="pt-avisos"><summary>${avisos.length} aviso${avisos.length === 1 ? '' : 's'} al leer el archivo</summary><ul>${avisos.map(a => `<li>${esc(a)}</li>`).join('')}</ul></details>` : ''}
        <p class="pt-nota">Los datos de abajo se aplican a todos. Cada elemento conserva su nombre y sus columnas del archivo; puede editarlos uno a uno después de guardar.</p>
        <label>Nombre para los que no traen<input name="nombre_base" maxlength="150" value="${esc(archivo.replace(/\.[^.]+$/, ''))}"></label>
        <label>Categoría<select name="categoria"><option value="">Sin categoría</option>${Object.entries(CAT).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
        <label>Método<textarea name="metodo" rows="3" maxlength="5000"></textarea></label>
        <div class="pt-fila2">
          <label>Desde<input type="date" name="fecha_inicio"></label>
          <label>Hasta<input type="date" name="fecha_fin"></label>
        </div>
        <p class="pt-error" id="pt-error" role="alert" hidden></p>
        <div class="pt-botonera">
          <button class="pt-btn" type="submit">Guardar ${elementos.length} registro${elementos.length === 1 ? '' : 's'}</button>
          <button class="pt-btn pt-btn--suave" type="button" data-accion="volver">Cancelar</button>
        </div>
      </form>`;
  }

  async function guardarImportados() {
    const fm = $('pt-imp2'), err = $('pt-error'), v = n => fm.elements[n].value.trim();
    const base = v('nombre_base') || 'Elemento';
    const registrosNuevos = importados.elementos.map((el, i) => ({
      geometria: el.geometry, nombre: el.nombre || `${base} ${i + 1}`, categoria: v('categoria'), metodo: v('metodo'),
      fecha_inicio: v('fecha_inicio') || null, fecha_fin: v('fecha_fin') || null, atributos: el.atributos,
      origen: importados.archivo,
    }));
    try {
      const r = await enviar('/portal/api/registros/crear', { registros: registrosNuevos });
      registros = [...registros, ...r.features];
      pintarRegistros(); vistaLista(); encuadrar();
      aviso(`${r.features.length} registros guardados`);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  }

  // ─── Medidas (aproximadas, esféricas) ──────────────────────────────────────
  function longitud(c) {
    let m = 0;
    for (let i = 1; i < c.length; i++) m += L.latLng(c[i - 1][1], c[i - 1][0]).distanceTo(L.latLng(c[i][1], c[i][0]));
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  }
  function superficie(anillo) {
    const R = 6378137, rad = Math.PI / 180;
    let s = 0;
    for (let i = 0; i < anillo.length - 1; i++) {
      const [x1, y1] = anillo[i], [x2, y2] = anillo[i + 1];
      s += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
    }
    const m2 = Math.abs(s * R * R / 2);
    return m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2)} m²`;
  }

  // ─── Avisos breves ─────────────────────────────────────────────────────────
  function aviso(texto, error = false) {
    const el = Object.assign(document.createElement('div'), { className: `pt-toast${error ? ' error' : ''}`, textContent: texto });
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ─── Vista: mi permiso (estado, resolución, etapas, documentos) ────────────
  let permiso = null;
  const fechaCl = iso => iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' }) : '–';

  async function vistaPermiso() {
    dibujo = null; importados = null; enFormulario = null;
    capaVista.clearLayers(); resaltar(null);
    if (!permiso) {
      panel.innerHTML = '<p class="pt-vacio">Consultando su permiso en Cero Filas…</p>';
      try { permiso = (await api('/portal/api/permiso')).permiso; }
      catch (e) { panel.innerHTML = `<p class="pt-error">${esc(e.message)}</p>`; return; }
      if (pestana !== 'permiso') return;
    }
    const p = permiso;
    const res = p.documentos.find(d => d.resolucion);
    const otros = p.documentos.filter(d => !d.resolucion);
    const clase = { completado: 'ok', rechazado: 'no' }[p.estado_clave] || 'curso';
    const actual = p.etapas.find(e => e.estado === 'pendiente');
    const resolucion = res
      ? `<a class="pt-btn pt-res-btn" href="/portal/api/documento/${encodeURIComponent(res.clave)}" target="_blank" rel="noopener">Ver resolución (${esc(res.formato)})</a>`
      : p.estado_clave === 'pendiente' ? '<p class="pt-nota">La resolución estará disponible aquí cuando CONAF termine la evaluación.</p>'
      : '<p class="pt-nota">La resolución no está adjunta en Cero Filas. Puede verla en su cuenta de Cero Filas.</p>';
    panel.innerHTML = `
      <section class="pt-estado pt-estado--${clase}">
        <span class="pt-eyebrow2">Estado del permiso #${p.id}</span>
        <strong>${esc(p.estado)}</strong>
        ${p.estado_clave === 'pendiente' && p.avance != null ? `<div class="pt-avance"><i style="width:${Math.min(100, p.avance)}%"></i></div><small>${p.avance}% de las etapas completadas</small>` : ''}
        ${p.fecha_resolucion ? `<small>Resuelto el ${fechaCl(p.fecha_resolucion)}</small>` : ''}
        ${p.motivo_rechazo ? `<p class="pt-motivo"><b>Motivo:</b> ${esc(p.motivo_rechazo)}</p>` : ''}
        ${resolucion}
      </section>
      ${actual?.titular ? `<div class="pt-accion-req"><b>Hay una etapa que requiere una acción suya:</b> «${esc(actual.nombre)}». Complétela en
        <a href="https://conaf.cerofilas.gob.cl" target="_blank" rel="noopener">Cero Filas</a>.</div>` : ''}
      <section class="pt-datos">
        <h2>Datos del permiso</h2>
        <dl>
          <dt>Tipo</dt><dd>${esc(p.tipo)}</dd>
          ${p.titulo ? `<dt>Proyecto</dt><dd>${esc(p.titulo)}</dd>` : ''}
          <dt>Áreas protegidas</dt><dd>${esc(p.areas.join(', ') || '–')}</dd>
          <dt>Regiones</dt><dd>${esc(p.regiones.join(', ') || '–')}</dd>
          <dt>Actividades</dt><dd>${p.actividades_inicio ? `${fechaCl(p.actividades_inicio)} al ${fechaCl(p.actividades_termino)}` : '–'}</dd>
          <dt>Ingreso</dt><dd>${fechaCl(p.fecha_ingreso)}</dd>
        </dl>
      </section>
      <section>
        <h2>Compromisos con CONAF</h2>
        <ul class="pt-compromisos">
          <li class="${registros.length ? 'hecho' : ''}"><button data-ir="registro">Registrar dónde trabaja (puntos, transectos y parcelas)</button>
            <small>${registros.length ? `${registros.length} registro${registros.length === 1 ? '' : 's'} ingresado${registros.length === 1 ? '' : 's'}` : 'Pendiente'}</small></li>
          ${p.numeral6 ? `<li><span>Al terminar, entregar a CONAF el informe final, las publicaciones y el material complementario</span>
            <small>Numeral 6 del Reglamento de investigación</small></li>` : ''}
          <li><span>Respetar el período, las áreas y las condiciones indicadas en la resolución</span></li>
        </ul>
      </section>
      <section>
        <h2>Etapas del trámite</h2>
        <ol class="pt-etapas">${p.etapas.map((e, i) => `<li class="pt-etapa-${e.estado === 'completado' ? 'hecha' : e.estado === 'pendiente' ? 'actual' : 'otra'}">
          <strong>${e.nombre && e.nombre !== 'Etapa' ? esc(e.nombre) : `Etapa ${i + 1}`}</strong>
          <small>${e.estado === 'completado' ? `Terminada el ${fechaCl(e.termino)}` : e.estado === 'pendiente' ? `En curso desde el ${fechaCl(e.inicio)}${e.titular ? ' · en sus manos' : ' · en CONAF'}` : esc(e.estado || '')}</small>
        </li>`).join('')}</ol>
      </section>
      ${otros.length ? `<section><h2>Documentos del trámite</h2><ul class="pt-docs">${otros.map(d =>
        `<li><a href="/portal/api/documento/${encodeURIComponent(d.clave)}" target="_blank" rel="noopener">${esc(d.nombre)}</a><span>${esc(d.formato)}</span></li>`).join('')}</ul></section>` : ''}
      <p class="pt-nota">Información tomada de Cero Filas. Para presentar documentos o responder observaciones, use su cuenta en
        <a href="https://conaf.cerofilas.gob.cl" target="_blank" rel="noopener">conaf.cerofilas.gob.cl</a>.</p>`;
  }

  // ─── Pestañas ──────────────────────────────────────────────────────────────
  let pestana = 'permiso';
  function marcarPestana(t) {
    pestana = t;
    document.querySelectorAll('.pt-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  }
  function irA(t) {
    marcarPestana(t);
    if (dibujo) { mapa.doubleClickZoom.enable(); mapa.getContainer().classList.remove('pt-dibujando'); }
    if (t === 'permiso') vistaPermiso(); else vistaLista();
  }
  document.querySelector('.pt-tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) irA(b.dataset.tab);
  });

  // ─── Eventos del panel ─────────────────────────────────────────────────────
  panel.addEventListener('click', e => {
    const b = e.target.closest('button, [data-vista]');
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    if (b.dataset.ir) return irA(b.dataset.ir);
    if (b.dataset.dibujar) return iniciarDibujo(b.dataset.dibujar);
    if (b.dataset.vista === 'coordenadas') return vistaCoordenadas();
    if (b.dataset.vista === 'importar') return vistaImportar();
    if (b.classList.contains('pt-reg')) return editar(Number(b.dataset.id));
    switch (b.dataset.accion) {
      case 'terminar': return terminarDibujo();
      case 'deshacer': dibujo.puntos.pop(); return redibujar();
      case 'cancelar': mapa.doubleClickZoom.enable(); return vistaLista();
      case 'volver': return vistaLista();
      case 'attr': $('pt-attr').insertAdjacentHTML('beforeend', filaAtributo()); return $('pt-attr').lastElementChild.querySelector('input').focus();
      case 'attr-quitar': return b.closest('.pt-attr-fila').remove();
      case 'borrar': return borrar();
      case 'redibujar': {
        const f = enFormulario;
        const tipo = { LineString: 'linea', Polygon: 'poligono' }[f.geometry.type];
        // conserva lo escrito en el formulario mientras se redibuja
        try { const d = leerFormulario(); f.properties = { ...f.properties, ...d }; } catch (_) { /* nombre vacío: se pedirá al guardar */ }
        return iniciarDibujo(tipo, f);
      }
    }
  });
  panel.addEventListener('submit', e => {
    e.preventDefault();
    if (e.target.id === 'pt-form') guardar();
    else if (e.target.id === 'pt-coord') desdeCoordenadas();
    else if (e.target.id === 'pt-imp') leerArchivo();
    else if (e.target.id === 'pt-imp2') guardarImportados();
  });
  panel.addEventListener('mouseover', e => {
    const b = e.target.closest('.pt-reg');
    if (b && !dibujo) resaltar(Number(b.dataset.id));
  });
  panel.addEventListener('mouseleave', () => { if (!dibujo && !enFormulario) resaltar(null); });
  document.addEventListener('keydown', e => {
    if (!dibujo) return;
    if (e.key === 'Escape') { mapa.doubleClickZoom.enable(); vistaLista(); }
    else if (e.key === 'Enter') terminarDibujo();
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && dibujo.puntos.length) { dibujo.puntos.pop(); redibujar(); }
  });

  // ─── Inicio ────────────────────────────────────────────────────────────────
  (async () => {
    encuadrar();
    vistaPermiso();
    try {
      registros = (await api('/portal/api/registros')).features;
      pintarRegistros(); encuadrar();
      if (pestana === 'registro') vistaLista(); else if (permiso) vistaPermiso();
    } catch (e) { aviso('No se pudieron cargar sus registros: ' + e.message, true); }
  })();
})();

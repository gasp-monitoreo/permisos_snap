/* ═══════════════════════════════════════════════
   Registro geográfico en el detalle del trámite (vista interna de CONAF).
   Muestra en un mapa los puntos, transectos y parcelas que declaró el titular en el
   portal del investigador, permite descargarlos (GeoJSON) y, al superusuario,
   generar o revocar el acceso temporal del solicitante.
   API: /api/tramites/{id}/registro-geografico, /api/accesos… (tramites/api.py)
   Usa de presion.js: _cargarLeaflet. De app.js: escHtml.
   ═══════════════════════════════════════════════ */
'use strict';
window.RegistroGeo = (() => {
  const COLORES = { punto: '#B9412F', linea: '#0155A0', poligono: '#347A17' };
  const NOMBRES = { punto: 'punto', linea: 'transecto', poligono: 'parcela' };
  let mapa = null;

  const fecha = iso => iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('es-CL') : '–';
  async function pedir(url, opciones = {}) {
    const r = await fetch(url, { ...opciones, headers: { 'Content-Type': 'application/json', ...(opciones.headers || {}) } });
    const d = (r.headers.get('Content-Type') || '').includes('json') ? await r.json() : null;
    if (!r.ok || !d || d.ok === false) throw new Error(d?.error || `Error ${r.status}`);
    return d;
  }

  function resumen(features) {
    const n = t => features.filter(f => f.properties.tipo === t).length;
    return Object.keys(NOMBRES).filter(n).map(t => `${n(t)} ${NOMBRES[t]}${n(t) === 1 ? '' : 's'}`).join(' · ');
  }

  function accesoHtml(acc) {
    if (!window.PERFIL?.superusuario) return '';
    const estado = !acc ? '<span class="rg-estado">Sin acceso generado</span>'
      : acc.vigente ? `<span class="rg-estado ok">Acceso vigente hasta ${fecha(acc.vence)}</span>`
      : `<span class="rg-estado no">${acc.revocado ? 'Acceso revocado' : `Acceso vencido el ${fecha(acc.vence)}`}</span>`;
    const ultimo = acc?.ultimo_ingreso ? ` · último ingreso ${fecha(acc.ultimo_ingreso)}` : acc ? ' · aún no ha ingresado' : '';
    return `<div class="rg-acceso">
      <div>${estado}<small>${acc ? `Usuario ${escHtml(acc.usuario)}${ultimo}` : 'El titular podrá marcar puntos, transectos y parcelas con su método y datos.'}</small></div>
      <div class="rg-acceso-btns">
        <button class="btn-primary" data-rg="generar">${acc ? 'Renovar acceso y nueva clave' : 'Generar acceso para el titular'}</button>
        ${acc?.vigente ? '<button class="btn-secondary" data-rg="revocar">Revocar</button>' : ''}
      </div>
      <div class="rg-credenciales" id="rg-credenciales" hidden></div>
    </div>`;
  }

  function credencialesHtml(r, t) {
    const msg = `Estimado/a ${t.nombre_solicitante || ''}:

Para el permiso N.° ${t.id}, CONAF le solicita registrar la ubicación de sus actividades (puntos de muestreo, transectos, parcelas u otros sitios) en el portal del investigador:

Enlace: ${r.enlace}
Usuario: ${r.acceso.usuario}
Clave: ${r.clave}

Puede marcarlos en el mapa, escribir coordenadas o importar archivos GPS/SIG (KML, GPX, GeoJSON, CSV o Shapefile), indicando el método y los datos de cada sitio. El acceso está vigente hasta el ${fecha(r.acceso.vence)}.

Saludos cordiales,
CONAF`;
    return `<p class="rg-aviso">Copie estos datos ahora: la clave no se vuelve a mostrar. Si se pierde, use «Renovar acceso».</p>
      <dl class="rg-dl"><dt>Enlace</dt><dd>${escHtml(r.enlace)}</dd><dt>Usuario</dt><dd><code>${escHtml(r.acceso.usuario)}</code></dd>
      <dt>Clave</dt><dd><code>${escHtml(r.clave)}</code></dd></dl>
      <textarea class="rg-msg" readonly rows="9">${escHtml(msg)}</textarea>
      <button class="btn-secondary" data-rg="copiar">Copiar mensaje para enviar al titular</button>`;
  }

  async function dibujarMapa(cont, features) {
    try { await _cargarLeaflet(); } catch (e) { cont.innerHTML = '<div class="empty-msg">No se pudo cargar el mapa.</div>'; return; }
    if (mapa) { mapa.remove(); mapa = null; }
    mapa = L.map(cont, { scrollWheelZoom: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics',
    }).addTo(mapa);
    const capa = L.geoJSON({ type: 'FeatureCollection', features }, {
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2, fillColor: COLORES.punto, fillOpacity: 1 }),
      style: f => f.geometry.type === 'Point' ? {} : { color: COLORES[f.properties.tipo], weight: 3, fillOpacity: .2 },
      onEachFeature: (f, l) => {
        const p = f.properties;
        const attrs = Object.entries(p.atributos || {}).slice(0, 8).map(([k, v]) => `<br><small>${escHtml(k)}: ${escHtml(v)}</small>`).join('');
        l.bindPopup(`<strong>${escHtml(p.nombre)}</strong><br>${escHtml(p.categoria_nombre || NOMBRES[p.tipo])}
          ${p.metodo ? `<br><em>Método:</em> ${escHtml(p.metodo.slice(0, 300))}` : ''}
          ${p.fecha_inicio ? `<br>${fecha(p.fecha_inicio)} – ${fecha(p.fecha_fin)}` : ''}${attrs}`);
      },
    }).addTo(mapa);
    mapa.fitBounds(capa.getBounds(), { padding: [20, 20], maxZoom: 16 });
    setTimeout(() => mapa.invalidateSize(), 150);   // el modal termina de abrirse después
  }

  // contenedor: dónde va el bloque (pestaña de la ficha) · alContar(n): avisa cuántos registros hay
  async function montar(t, contenedor = null, alContar = null) {
    const body = contenedor || document.getElementById('modal-tramite-body');
    if (!body) return;
    if (contenedor) contenedor.innerHTML = '';
    body.insertAdjacentHTML('beforeend', `<div class="detail-section rg-seccion" id="rg-seccion" style="margin-top:18px">
      <div class="detail-section-title">📍 Registro geográfico del permiso</div>
      <div id="rg-cuerpo"><div class="empty-msg">Cargando…</div></div></div>`);
    const cuerpo = document.getElementById('rg-cuerpo');
    let d;
    try { d = await pedir(`/api/tramites/${t.id}/registro-geografico`); }
    catch (e) { cuerpo.innerHTML = `<div class="empty-msg">${escHtml(e.message)}</div>`; return; }
    if (!document.body.contains(cuerpo)) return;   // el usuario ya abrió otro trámite
    const n = d.features.length;
    if (alContar) alContar(n);
    cuerpo.innerHTML = `
      ${n ? `<p class="rg-resumen">${resumen(d.features)} declarados por el titular.
          <a href="/api/tramites/${t.id}/registro-geografico.geojson">Descargar GeoJSON</a> (abre en QGIS o ArcGIS)</p>
        <div class="rg-mapa" id="rg-mapa"></div>`
      : '<p class="rg-resumen">El titular aún no ha registrado puntos, transectos ni parcelas.</p>'}
      ${accesoHtml(d.acceso)}`;
    if (n) dibujarMapa(document.getElementById('rg-mapa'), d.features);

    cuerpo.addEventListener('click', async e => {
      const b = e.target.closest('[data-rg]');
      if (!b) return;
      if (b.dataset.rg === 'copiar') {
        const ta = cuerpo.querySelector('.rg-msg');
        try { await navigator.clipboard.writeText(ta.value); b.textContent = 'Copiado ✓'; }
        catch { ta.select(); b.textContent = 'Seleccionado: copie con Ctrl+C'; }
        return;
      }
      if (b.dataset.rg === 'revocar' && !confirm('¿Revocar el acceso? El titular ya no podrá ingresar al portal.')) return;
      if (b.dataset.rg === 'generar' && d.acceso && !confirm('Se generará una clave nueva; la anterior dejará de funcionar. ¿Continuar?')) return;
      b.setAttribute('aria-busy', 'true'); b.disabled = true;
      try {
        if (b.dataset.rg === 'generar') {
          const r = await pedir('/api/accesos', { method: 'POST', body: JSON.stringify({ tramite_id: t.id }) });
          d.acceso = r.acceso;
          cuerpo.querySelector('.rg-acceso').outerHTML = accesoHtml(d.acceso);
          const cred = document.getElementById('rg-credenciales');
          cred.innerHTML = credencialesHtml(r, t);
          cred.hidden = false;
        } else {
          const r = await pedir(`/api/accesos/${d.acceso.id}/revocar`, { method: 'POST', body: '{}' });
          d.acceso = r.acceso;
          cuerpo.querySelector('.rg-acceso').outerHTML = accesoHtml(d.acceso);
        }
      } catch (err) {
        alert(err.message);
        b.disabled = false; b.removeAttribute('aria-busy');
      }
    });
  }

  return { montar };
})();

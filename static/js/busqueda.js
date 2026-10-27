/* ═══════════════════════════════════════════════
   Búsqueda: instantánea, tolerante a tildes y errores de tipeo, con filtros facetados.
   - Índice liviano de todos los años (/api/buscar/indice), independiente del rango
     de años de la barra superior. Se carga una vez, al abrir la sección.
   - Filtros con conteos que se recalculan (cada grupo cuenta con los demás filtros
     aplicados), chips de filtros activos, orden y exportación de los resultados.
   - El estado queda en la URL (?bq=1&q=…) para compartir una búsqueda.
   Usa de app.js: _normInv, situacionTramite, fechaVencimientoEfectiva, clasificarConjunto,
   badgeHtml, tipoBadgeHtml, openModal, loadTramite, escHtml, formatDate, safeUrl,
   _uploadPanelHtml, _carpetaExistenteParaInv, _normCarpetaNombre, _archivosExistentesPorId,
   REGIONES_CHILE, IDS_INVESTIGACION. De resumen.js: RES_ESTADOS.
   ═══════════════════════════════════════════════ */
'use strict';
(() => {
  const $b = id => document.getElementById(id);
  const DIA = 86400000;
  const POR_PAGINA = 30;
  const PESOS = { id: 100, nombre: 40, area: 30, titulo: 20, texto: 8 };
  const EXTRAS = {
    vence7:      'Vence en 7 días',
    espera30:    'Espera al solicitante hace más de 30 días',
    registro:    'Con registro geográfico',
    sinregistro: 'Sin registro geográfico',
    archivos:    'Con archivos entregados',
  };
  const ORDENES = { relevancia: 'Relevancia', reciente: 'Más reciente', atraso: 'Más días de atraso', antiguo: 'Más antiguo' };
  const ATAJOS = [
    ['Atrasadas en CONAF', { sit: ['vencido'] }, '#B9412F'],
    ['Vencen esta semana', { extra: ['vence7'] }, '#B9831F'],
    ['Esperan al solicitante hace más de 30 días', { extra: ['espera30'] }, '#3F7CB8'],
    ['Aprobadas sin registro geográfico', { sit: ['completado'], extra: ['sinregistro'] }, '#347A17'],
    ['Con archivos entregados', { extra: ['archivos'] }, '#0155A0'],
  ];

  let indice = null, cargando = null, vocabulario = [];
  const variantesCache = new Map();
  let est = vacio();
  let pagina = 1, sugeridos = [], sugIdx = -1, temporizador = null;

  function vacio() {
    return { q: '', tipo: [], sit: [], reg: [], area: [], tema: [], extra: [], desde: '', hasta: '', orden: 'relevancia' };
  }
  const hayFiltros = () => ['tipo', 'sit', 'reg', 'area', 'tema', 'extra'].some(k => est[k].length) || est.desde || est.hasta;

  // ─── Carga y preparación del índice ────────────────────────────────────────
  function cargar() {
    if (cargando) return cargando;
    cargando = (async () => {
      $b('bq-estado').textContent = 'Cargando trámites de todos los años…';
      const r = await fetch('/api/buscar/indice');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'No se pudo cargar el índice');
      preparar(j.data);
      if (!window.PERFIL?.ve_sensible && window.avisoPrivacidad && !$b('bq-aviso')) {
        $b('bq-estado').insertAdjacentHTML('afterend', `<div class="bq-aviso" id="bq-aviso">${window.avisoPrivacidad()}</div>`);
      }
      $b('bq-estado').textContent = j.pendientes?.length
        ? `Aún se están descargando los años ${j.pendientes.join(', ')}; se agregarán solos en un minuto.`
        : `${indice.length.toLocaleString('es-CL')} trámites desde ${j.desde}.`;
      if (j.pendientes?.length) setTimeout(() => { cargando = null; cargar().then(pintar); }, 60000);
    })().catch(e => { cargando = null; $b('bq-estado').textContent = 'No se pudo cargar la búsqueda: ' + e.message; throw e; });
    return cargando;
  }

  function preparar(datos) {
    const hoy = Date.now();
    const { temas } = clasificarConjunto(datos);
    const vocab = new Set();
    indice = datos.map(t => {
      const sit = situacionTramite(t);
      const fv = fechaVencimientoEfectiva(t);
      const dVence = fv ? Math.ceil((new Date(fv) - hoy) / DIA) : null;
      const ea = t.etapa_actual || {};
      const r = {
        t, sit,
        tipo: IDS_INVESTIGACION.has(t.proceso_id) ? 'inv' : 'film',
        anio: t.fecha_inicio ? new Date(t.fecha_inicio).getFullYear() : null,
        tema: temas.get(t.id) || 'Otros',
        atraso: sit === 'vencido' && dVence !== null ? -dVence : 0,
        vence7: sit === 'al_dia' && dVence !== null && dVence >= 0 && dVence <= 7,
        espera: sit === 'espera_solicitante' && ea.fecha_inicio ? Math.floor((hoy - new Date(ea.fecha_inicio)) / DIA) : 0,
        f: {
          id: String(t.id),
          nombre: _normInv(`${t.nombre_solicitante} ${t.email_solicitante}`),
          area: _normInv([...t.areas_protegidas, ...t.regiones_list].join(' ')),
          titulo: _normInv(t.titulo_investigacion),
          texto: _normInv(`${t.texto_clasificacion} ${ea.tarea_nombre || ''}`),
        },
      };
      Object.values(r.f).forEach(v => v.split(' ').forEach(w => { if (w.length >= 4) vocab.add(w); }));
      return r;
    });
    vocabulario = [...vocab];
    variantesCache.clear();
  }

  const tieneArchivos = r => {
    if (r.tipo !== 'inv' || typeof STATE === 'undefined' || !STATE.investigaciones) return false;
    const nombre = r.t.nombre_solicitante || '';
    const carpeta = _carpetaExistenteParaInv(nombre) || _normCarpetaNombre(nombre);
    return _archivosExistentesPorId(carpeta, r.t.id).length > 0;
  };

  // ─── Coincidencia con tolerancia a errores (Damerau-Levenshtein ≤ 1) ──────
  function unaDiferencia(a, b) {
    if (Math.abs(a.length - b.length) > 1 || a === b) return a === b;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) {
      return a.slice(i + 1) === b.slice(i + 1)                                  // sustitución
        || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));   // transposición
    }
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);   // inserción
  }

  function variantes(tok) {
    if (variantesCache.has(tok)) return variantesCache.get(tok);
    const v = [{ s: tok, exacta: true }];
    if (tok.length >= 5) {
      for (const w of vocabulario) {
        if (w.includes(tok)) continue;                       // ya lo cubre la coincidencia exacta
        if (unaDiferencia(tok, w)) { v.push({ s: w, exacta: false }); continue; }
        if (w.length > tok.length + 1) {                     // error dentro de una palabra más larga
          for (const largo of [tok.length - 1, tok.length, tok.length + 1]) {
            const pref = w.slice(0, largo);
            if (pref !== tok && unaDiferencia(tok, pref)) { v.push({ s: pref, exacta: false }); break; }
          }
        }
      }
    }
    const unicas = [...new Map(v.map(x => [x.s, x])).values()].slice(0, 12);
    variantesCache.set(tok, unicas);
    return unicas;
  }

  const tokens = () => _normInv(est.q).split(' ').filter(Boolean);

  function puntaje(r, toks) {
    let total = 0;
    for (const tok of toks) {
      let mejor = 0;
      for (const v of variantes(tok)) {
        for (const [campo, peso] of Object.entries(PESOS)) {
          const txt = r.f[campo];
          const i = txt.indexOf(v.s);
          if (i < 0) continue;
          let p = peso * (v.exacta ? 1 : .6);
          if (i === 0 || txt[i - 1] === ' ') p *= 1.3;          // inicio de palabra
          if (campo === 'id' && txt === v.s) p *= 3;
          mejor = Math.max(mejor, p);
        }
      }
      if (!mejor) return 0;
      total += mejor;
    }
    return total;
  }

  // ─── Filtros ───────────────────────────────────────────────────────────────
  const pasa = {
    tipo: r => !est.tipo.length || est.tipo.includes(r.tipo),
    sit: r => !est.sit.length || est.sit.includes(r.sit),
    reg: r => !est.reg.length || r.t.regiones_list.some(x => est.reg.includes(x)),
    area: r => !est.area.length || r.t.areas_protegidas.some(x => est.area.includes(x)),
    tema: r => !est.tema.length || est.tema.includes(r.tema),
    anio: r => (!est.desde || (r.anio && r.anio >= +est.desde)) && (!est.hasta || (r.anio && r.anio <= +est.hasta)),
    extra: r => est.extra.every(x => x === 'vence7' ? r.vence7 : x === 'espera30' ? r.espera > 30
      : x === 'registro' ? r.t.tiene_registro : x === 'sinregistro' ? !r.t.tiene_registro : x === 'archivos' ? tieneArchivos(r) : true),
  };
  const DIMENSIONES = Object.keys(pasa);

  function calcular() {
    const toks = tokens();
    const base = [];
    for (const r of indice) {
      const s = toks.length ? puntaje(r, toks) : 1;
      if (s) base.push({ r, s });
    }
    // conteo de cada grupo con todos los demás filtros aplicados
    const facetas = {};
    const sin = dim => base.filter(x => DIMENSIONES.every(d => d === dim || pasa[d](x.r)));
    const contar = (lista, fn) => {
      const m = new Map();
      lista.forEach(x => [].concat(fn(x.r)).forEach(k => { if (k) m.set(k, (m.get(k) || 0) + 1); }));
      return m;
    };
    facetas.tipo = contar(sin('tipo'), r => r.tipo);
    facetas.sit = contar(sin('sit'), r => r.sit);
    facetas.reg = contar(sin('reg'), r => r.t.regiones_list);
    facetas.area = contar(sin('area'), r => r.t.areas_protegidas);
    facetas.tema = contar(sin('tema'), r => r.tema);
    const sinExtra = sin('extra');
    facetas.extra = new Map(Object.keys(EXTRAS).map(k => {
      const guardado = est.extra;
      est.extra = [k];
      const n = sinExtra.filter(x => pasa.extra(x.r)).length;
      est.extra = guardado;
      return [k, n];
    }));
    const res = base.filter(x => DIMENSIONES.every(d => pasa[d](x.r)));
    const fecha = x => x.r.t.fecha_inicio || '';
    const orden = {
      relevancia: (a, b) => b.s - a.s || (fecha(b) > fecha(a) ? 1 : -1),
      reciente: (a, b) => (fecha(b) > fecha(a) ? 1 : -1),
      antiguo: (a, b) => (fecha(a) > fecha(b) ? 1 : -1),
      atraso: (a, b) => b.r.atraso - a.r.atraso || b.r.espera - a.r.espera,
    }[est.orden];
    res.sort(orden);
    return { res, facetas, toks };
  }

  // ─── Resaltado sin importar tildes ─────────────────────────────────────────
  const normChar = c => c.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ' ')[0] || ' ';
  function resaltar(texto, toks) {
    texto = String(texto || '');
    if (!toks.length || !texto) return escHtml(texto);
    const norm = [...texto].map(normChar).join('');
    const marcas = new Array(norm.length).fill(false);
    toks.flatMap(t => variantes(t).map(v => v.s)).forEach(s => {
      let i = norm.indexOf(s);
      while (i >= 0) { for (let k = i; k < i + s.length; k++) marcas[k] = true; i = norm.indexOf(s, i + s.length); }
    });
    const chars = [...texto];
    let html = '', abierto = false;
    chars.forEach((c, i) => {
      if (marcas[i] && !abierto) { html += '<mark>'; abierto = true; }
      if (!marcas[i] && abierto) { html += '</mark>'; abierto = false; }
      html += escHtml(c);
    });
    return html + (abierto ? '</mark>' : '');
  }

  function fragmento(r, toks) {
    if (!toks.length) return '';
    const enVisible = toks.every(t => variantes(t).some(v => r.f.titulo.includes(v.s) || r.f.nombre.includes(v.s) || r.f.area.includes(v.s) || r.f.id.includes(v.s)));
    if (enVisible) return '';
    const texto = r.t.texto_clasificacion || '';
    const norm = [...texto].map(normChar).join('');
    const v = toks.flatMap(t => variantes(t).map(x => x.s)).find(s => norm.includes(s));
    if (!v) return '';
    const i = norm.indexOf(v), ini = Math.max(0, i - 70), fin = Math.min(texto.length, i + v.length + 90);
    return `<p class="bq-frag">${ini ? '…' : ''}${resaltar(texto.slice(ini, fin), toks)}${fin < texto.length ? '…' : ''}</p>`;
  }

  // ─── Pintado ───────────────────────────────────────────────────────────────
  const etiquetaSit = k => (RES_ESTADOS.find(e => e.key === k) || {}).label || k;
  const colorSit = k => (RES_ESTADOS.find(e => e.key === k) || {}).color || '#888';

  function grupo(dim, titulo, mapa, opciones = {}) {
    const elegidos = est[dim];
    let items = opciones.orden ? opciones.orden.filter(k => mapa.has(k) || elegidos.includes(k)) : [...mapa.keys()].sort((a, b) => mapa.get(b) - mapa.get(a));
    elegidos.forEach(k => { if (!items.includes(k)) items.unshift(k); });
    const filtroTxt = opciones.buscable ? _normInv($b(`bq-f-${dim}`)?.value || '') : '';
    if (filtroTxt) items = items.filter(k => _normInv(opciones.etiqueta ? opciones.etiqueta(k) : k).includes(filtroTxt));
    const limite = opciones.limite && !$b('bq-filtros').dataset[`todo_${dim}`] ? opciones.limite : Infinity;
    const visibles = items.slice(0, limite);
    if (!items.length && !opciones.buscable) return '';
    return `<details class="bq-grupo" open data-grupo="${dim}"><summary>${titulo}${elegidos.length ? ` <span class="bq-cuenta">${elegidos.length}</span>` : ''}</summary>
      ${opciones.buscable ? `<input class="bq-f-buscar" id="bq-f-${dim}" placeholder="Buscar ${titulo.toLowerCase()}…" value="${escHtml($b(`bq-f-${dim}`)?.value || '')}" aria-label="Buscar en ${escHtml(titulo)}">` : ''}
      <ul>${visibles.map(k => `<li><label class="bq-op">
        <input type="checkbox" data-dim="${dim}" value="${escHtml(k)}" ${elegidos.includes(k) ? 'checked' : ''}>
        ${opciones.color ? `<i style="background:${opciones.color(k)}"></i>` : ''}
        <span>${escHtml(opciones.etiqueta ? opciones.etiqueta(k) : k)}</span><em>${(mapa.get(k) || 0).toLocaleString('es-CL')}</em></label></li>`).join('')}</ul>
      ${items.length > visibles.length ? `<button class="bq-mas-op" data-todo="${dim}">Ver ${items.length - visibles.length} más</button>` : ''}
    </details>`;
  }

  function pintarFiltros(f) {
    const anios = [...new Set(indice.map(r => r.anio).filter(Boolean))].sort();
    const foco = document.activeElement?.id;
    $b('bq-filtros-cuerpo').innerHTML = `
      ${grupo('tipo', 'Tipo', f.tipo, { orden: ['inv', 'film'], etiqueta: k => k === 'inv' ? 'Investigación' : 'Filmación y fotografía' })}
      ${grupo('sit', 'Situación', f.sit, { orden: RES_ESTADOS.map(e => e.key), etiqueta: etiquetaSit, color: colorSit })}
      <details class="bq-grupo" open><summary>Año de ingreso</summary><div class="bq-anios">
        <select id="bq-desde" aria-label="Desde"><option value="">Desde</option>${anios.map(a => `<option ${+est.desde === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
        <span>–</span>
        <select id="bq-hasta" aria-label="Hasta"><option value="">Hasta</option>${anios.map(a => `<option ${+est.hasta === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div></details>
      ${grupo('reg', 'Región', f.reg, { orden: REGIONES_CHILE.map(r => r.nombre) })}
      ${grupo('area', 'Área protegida', f.area, { buscable: true, limite: 8 })}
      ${grupo('tema', 'Tema', f.tema, { limite: 8 })}
      ${grupo('extra', 'Seguimiento', f.extra, { orden: Object.keys(EXTRAS), etiqueta: k => EXTRAS[k] })}`;
    if (foco && foco.startsWith('bq-f-')) { const el = $b(foco); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }
    const n = ['tipo', 'sit', 'reg', 'area', 'tema', 'extra'].reduce((s, k) => s + est[k].length, 0) + (est.desde ? 1 : 0) + (est.hasta ? 1 : 0);
    $b('bq-btn-filtros').textContent = n ? `Filtros (${n})` : 'Filtros';
  }

  function chips() {
    const c = [];
    const et = { tipo: k => k === 'inv' ? 'Investigación' : 'Filmación y fotografía', sit: etiquetaSit, extra: k => EXTRAS[k] };
    ['tipo', 'sit', 'reg', 'area', 'tema', 'extra'].forEach(d => est[d].forEach(k =>
      c.push(`<button class="bq-chip" data-quitar="${d}" data-valor="${escHtml(k)}">${escHtml((et[d] || (x => x))(k))} <span aria-hidden="true">✕</span></button>`)));
    if (est.desde || est.hasta) c.push(`<button class="bq-chip" data-quitar="anio">${est.desde || '…'}–${est.hasta || 'hoy'} <span aria-hidden="true">✕</span></button>`);
    return c.length ? `<div class="bq-chips">${c.join('')}<button class="bq-limpiar" data-limpiar>Limpiar todo</button></div>` : '';
  }

  function tarjeta(x, toks) {
    const r = x.r, t = r.t;
    const lugar = [...t.areas_protegidas.slice(0, 2), ...(t.areas_protegidas.length ? [] : t.regiones_list)].join(' · ')
      + (t.areas_protegidas.length > 2 ? ` +${t.areas_protegidas.length - 2}` : '');
    const ea = t.etapa_actual || {};
    const estado = r.sit === 'vencido' ? `<b class="bq-rojo">${r.atraso} d de atraso</b>`
      : r.vence7 ? `<b class="bq-ambar">vence en ${Math.max(0, Math.ceil((new Date(fechaVencimientoEfectiva(t)) - Date.now()) / DIA))} d</b>`
      : r.sit === 'espera_solicitante' ? `<b class="bq-azul">espera al solicitante ${r.espera} d</b>` : escHtml(etiquetaSit(r.sit));
    const conaf = t.archivo_autorizacion
      ? `<a class="bq-accion" href="${safeUrl(`https://conaf.cerofilas.gob.cl/backend/seguimiento/${t.etapa_autorizacion_id ? `ver_etapa/${t.etapa_autorizacion_id}` : `ver/${t.id}`}`)}" target="_blank" rel="noopener">Autorización en Cero Filas ↗</a>` : '';
    const nArch = r.tipo === 'inv' && typeof STATE !== 'undefined' && STATE.investigaciones ? _archivosExistentesPorId(_carpetaExistenteParaInv(t.nombre_solicitante || '') || _normCarpetaNombre(t.nombre_solicitante || ''), t.id).length : 0;
    const archivos = r.tipo === 'inv' ? `<button class="bq-accion btn-archivos ${nArch ? 'btn-archivos--tiene' : ''}" id="btn-archivos-${t.id}" onclick="toggleUploadPanel(${t.id})">📁 ${nArch ? `${nArch} archivo${nArch === 1 ? '' : 's'}` : 'Agregar archivos'}</button>` : '';
    return `<article class="bq-item">
      <button class="bq-item-main" data-abrir="${t.id}">
        <span class="bq-l1"><span class="bq-id">#${resaltar(t.id, toks)}</span>${badgeHtml(t.estado, { recepcionPendiente: t.recepcion_pendiente, tramite: t })}${tipoBadgeHtml(t)}
          <span class="bq-sol">${resaltar(t.nombre_solicitante || 'Sin nombre', toks)}</span><span class="bq-fecha">${formatDate(t.fecha_inicio)}</span></span>
        <span class="bq-tit">${resaltar(t.titulo_investigacion || '(sin título)', toks)}</span>
        <span class="bq-l3">${resaltar(lugar || 'Sin ubicación', toks)}${ea.tarea_nombre ? ` · ${escHtml(ea.tarea_nombre)}` : ''} · ${estado}${r.tema !== 'Otros' ? ` · <span class="bq-tema">${escHtml(r.tema)}</span>` : ''}${t.tiene_registro ? ' · 📍 registro geográfico' : ''}</span>
        ${fragmento(r, toks)}
      </button>
      ${conaf || archivos ? `<div class="bq-acciones">${conaf}${archivos}</div>` : ''}
      ${r.tipo === 'inv' ? `<table class="bq-upload"><tbody>${_uploadPanelHtml(t)}</tbody></table>` : ''}
    </article>`;
  }

  function vacioHtml() {
    let recientes = [];
    try { recientes = JSON.parse(localStorage.getItem('bq-recientes') || '[]'); } catch (e) { /* sin almacenamiento */ }
    return `<div class="bq-inicio">
      <h3>Atajos</h3>
      <div class="bq-atajos">${ATAJOS.map(([t, , c], i) => `<button class="bq-atajo" data-atajo="${i}" style="--c:${c}">${escHtml(t)}</button>`).join('')}</div>
      ${recientes.length ? `<h3>Búsquedas recientes</h3><div class="bq-recientes">${recientes.map(q => `<button data-reciente="${escHtml(q)}">${escHtml(q)}</button>`).join('')}</div>` : ''}
      <p class="bq-consejo">Escriba un nombre, correo, número de trámite, área protegida, especie o tema. Busca en todos los años, sin importar tildes ni pequeños errores de tipeo.
        También puede explorar solo con los filtros de la izquierda.</p>
    </div>`;
  }

  function pintar() {
    if (!indice) return;
    const { res, facetas, toks } = calcular();
    pintarFiltros(facetas);
    guardarUrl();
    const cont = $b('bq-resultados');
    if (!est.q && !hayFiltros()) {
      $b('bq-barra-res').innerHTML = '';
      cont.innerHTML = vacioHtml();
      return;
    }
    const puedeExportar = (window.PERFIL?.secciones || []).includes('exportar');
    $b('bq-barra-res').innerHTML = `
      <div class="bq-barra-fila">
        <strong class="bq-total">${res.length.toLocaleString('es-CL')} resultado${res.length === 1 ? '' : 's'}</strong>
        <label class="bq-orden">Ordenar <select id="bq-orden">${Object.entries(ORDENES).map(([k, v]) => `<option value="${k}" ${est.orden === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        ${puedeExportar && res.length ? `<button class="bq-exportar" id="bq-exportar">Exportar a Excel</button>
          <button class="bq-exportar" id="bq-zip" title="Resoluciones de los primeros 150 resultados">Resoluciones (ZIP)</button>` : ''}
      </div>${chips()}`;
    if (!res.length) {
      cont.innerHTML = `<div class="bq-nada"><strong>Sin resultados.</strong>
        ${hayFiltros() ? 'Pruebe quitando algún filtro (los números junto a cada opción indican cuántos quedarían).' : 'Revise la ortografía o use menos palabras.'}</div>`;
      return;
    }
    const vis = res.slice(0, pagina * POR_PAGINA);
    cont.innerHTML = vis.map(x => tarjeta(x, toks)).join('')
      + (res.length > vis.length ? `<button class="bq-ver-mas" id="bq-ver-mas">Ver ${Math.min(POR_PAGINA, res.length - vis.length)} más de ${(res.length - vis.length).toLocaleString('es-CL')}</button>` : '');
    cont.dataset.ids = JSON.stringify(res.map(x => x.r.t.id));
  }

  // ─── Sugerencias mientras se escribe ───────────────────────────────────────
  function sugerir() {
    const box = $b('bq-sug');
    const q = _normInv(est.q);
    if (!indice || q.length < 2) { box.hidden = true; sugeridos = []; return; }
    const toks = tokens();
    const coincide = txt => toks.every(t => variantes(t).some(v => txt.includes(v.s)));   // tolera errores de tipeo
    const areas = new Map(), personas = new Map(), temas = new Map();
    indice.forEach(r => {
      r.t.areas_protegidas.forEach(a => { if (coincide(_normInv(a))) areas.set(a, (areas.get(a) || 0) + 1); });
      if (r.t.nombre_solicitante && coincide(r.f.nombre)) personas.set(r.t.nombre_solicitante, (personas.get(r.t.nombre_solicitante) || 0) + 1);
      if (coincide(_normInv(r.tema))) temas.set(r.tema, (temas.get(r.tema) || 0) + 1);
    });
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    sugeridos = [
      ...top(areas, 4).map(([v, n]) => ({ tipo: 'area', v, n, g: 'Áreas protegidas' })),
      ...top(personas, 4).map(([v, n]) => ({ tipo: 'q', v, n, g: 'Solicitantes' })),
      ...top(temas, 3).map(([v, n]) => ({ tipo: 'tema', v, n, g: 'Temas' })),
    ];
    sugIdx = -1;
    if (!sugeridos.length) { box.hidden = true; return; }
    let g = '';
    box.innerHTML = sugeridos.map((s, i) => {
      const cab = s.g !== g ? `<div class="bq-sug-g">${s.g}</div>` : '';
      g = s.g;
      return `${cab}<button class="bq-sug-op" data-sug="${i}" role="option"><span>${resaltar(s.v, tokens())}</span><em>${s.n}</em></button>`;
    }).join('');
    box.hidden = false;
  }

  function elegirSugerencia(i) {
    const s = sugeridos[i];
    if (!s) return;
    if (s.tipo === 'q') est.q = s.v;
    else { est[s.tipo] = [...new Set([...est[s.tipo], s.v])]; est.q = ''; }
    $b('bq-q').value = est.q;
    $b('bq-sug').hidden = true;
    pagina = 1;
    pintar();
  }

  // ─── URL y recientes ───────────────────────────────────────────────────────
  function guardarUrl() {
    const p = new URLSearchParams();
    if (est.q || hayFiltros()) p.set('bq', '1');
    if (est.q) p.set('q', est.q);
    ['tipo', 'sit', 'reg', 'area', 'tema', 'extra'].forEach(k => { if (est[k].length) p.set(k, est[k].join('|')); });
    if (est.desde) p.set('desde', est.desde);
    if (est.hasta) p.set('hasta', est.hasta);
    if (est.orden !== 'relevancia') p.set('orden', est.orden);
    const s = p.toString();
    history.replaceState(null, '', location.pathname + (s ? `?${s}` : '') + location.hash);
  }

  function leerUrl() {
    const p = new URLSearchParams(location.search);
    if (!p.has('bq')) return false;
    est = vacio();
    est.q = p.get('q') || '';
    ['tipo', 'sit', 'reg', 'area', 'tema', 'extra'].forEach(k => { if (p.get(k)) est[k] = p.get(k).split('|'); });
    est.desde = p.get('desde') || ''; est.hasta = p.get('hasta') || '';
    est.orden = ORDENES[p.get('orden')] ? p.get('orden') : 'relevancia';
    return true;
  }

  function recordar() {
    const q = est.q.trim();
    if (q.length < 3 || /^\d+$/.test(q)) return;
    try {
      const l = JSON.parse(localStorage.getItem('bq-recientes') || '[]').filter(x => x !== q);
      localStorage.setItem('bq-recientes', JSON.stringify([q, ...l].slice(0, 6)));
    } catch (e) { /* sin almacenamiento */ }
  }

  // Descarga un archivo generado a partir de una lista de trámites (Excel o ZIP)
  async function descargarLista(boton, url, ids, nombre) {
    const texto = boton.textContent;
    boton.textContent = 'Preparando…'; boton.disabled = true;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      if (!r.ok) throw new Error(`Error ${r.status}`);
      const enlace = URL.createObjectURL(await r.blob());
      Object.assign(document.createElement('a'), { href: enlace, download: nombre }).click();
      setTimeout(() => URL.revokeObjectURL(enlace), 5000);
    } catch (err) { alert('No se pudo descargar: ' + err.message); }
    boton.textContent = texto; boton.disabled = false;
  }
  window.descargarListaTramites = descargarLista;   // también la usa la tabla de Desempeño (resumen.js)

  // ─── Eventos ───────────────────────────────────────────────────────────────
  async function abrirSeccion() {
    try { await cargar(); } catch (e) { return; }
    pintar();
  }

  async function alEscribir() {
    est.q = $b('bq-q').value;
    pagina = 1;
    clearTimeout(temporizador);
    if (/^#?\d{6,}$/.test(est.q.trim())) {           // número de trámite: se puede abrir directo
      $b('bq-sug').innerHTML = `<button class="bq-sug-op" data-abrir-id="${est.q.replace('#', '').trim()}"><span>Abrir el trámite #${escHtml(est.q.replace('#', '').trim())}</span><em>Enter</em></button>`;
      $b('bq-sug').hidden = false;
    } else sugerir();
    temporizador = setTimeout(() => { pintar(); setTimeout(recordar, 1500); }, 180);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const q = $b('bq-q');
    if (!q) return;
    document.querySelector('.tab-btn[data-tab="busqueda"]')?.addEventListener('click', abrirSeccion);
    q.addEventListener('focus', () => cargar().catch(() => {}));
    q.addEventListener('input', alEscribir);
    q.addEventListener('keydown', e => {
      const ops = [...$b('bq-sug').querySelectorAll('.bq-sug-op')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!ops.length || $b('bq-sug').hidden) return;
        e.preventDefault();
        sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + ops.length) % ops.length;
        ops.forEach((o, i) => o.classList.toggle('activa', i === sugIdx));
      } else if (e.key === 'Enter') {
        const directo = $b('bq-sug').querySelector('[data-abrir-id]');
        if (directo) { openModal(Number(directo.dataset.abrirId)); return; }
        if (sugIdx >= 0) { e.preventDefault(); ops[sugIdx]?.click(); return; }
        $b('bq-sug').hidden = true; clearTimeout(temporizador); pintar(); recordar();
      } else if (e.key === 'Escape') {
        if (!$b('bq-sug').hidden) $b('bq-sug').hidden = true;
        else { q.value = ''; alEscribir(); }
      }
    });
    $b('bq-sug').addEventListener('mousedown', e => e.preventDefault());   // no perder el foco al elegir
    $b('bq-sug').addEventListener('click', e => {
      const d = e.target.closest('[data-abrir-id]');
      if (d) { openModal(Number(d.dataset.abrirId)); $b('bq-sug').hidden = true; return; }
      const op = e.target.closest('[data-sug]');
      if (op) elegirSugerencia(Number(op.dataset.sug));
    });
    q.addEventListener('blur', () => setTimeout(() => { $b('bq-sug').hidden = true; }, 120));

    // tecla «/» para buscar desde cualquier parte de la sección
    document.addEventListener('keydown', e => {
      if (e.key !== '/' || !$b('tab-busqueda').classList.contains('active')) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      e.preventDefault(); q.focus();
    });

    const filtros = $b('bq-filtros');
    filtros.addEventListener('change', e => {
      const cb = e.target.closest('input[type=checkbox][data-dim]');
      if (cb) {
        const d = cb.dataset.dim;
        est[d] = cb.checked ? [...est[d], cb.value] : est[d].filter(x => x !== cb.value);
      } else if (e.target.id === 'bq-desde') est.desde = e.target.value;
      else if (e.target.id === 'bq-hasta') est.hasta = e.target.value;
      else return;
      pagina = 1; pintar();
    });
    filtros.addEventListener('input', e => { if (e.target.classList.contains('bq-f-buscar')) pintar(); });
    filtros.addEventListener('click', e => {
      const m = e.target.closest('[data-todo]');
      if (m) { filtros.dataset[`todo_${m.dataset.todo}`] = '1'; pintar(); }
      if (e.target.closest('#bq-cerrar-filtros')) filtros.classList.remove('abierto');
    });
    $b('bq-btn-filtros').addEventListener('click', () => filtros.classList.toggle('abierto'));

    const zona = $b('bq-zona');
    zona.addEventListener('click', async e => {
      const ab = e.target.closest('[data-abrir]');
      if (ab) return openModal(Number(ab.dataset.abrir));
      const ch = e.target.closest('[data-quitar]');
      if (ch) {
        if (ch.dataset.quitar === 'anio') { est.desde = ''; est.hasta = ''; }
        else est[ch.dataset.quitar] = est[ch.dataset.quitar].filter(x => x !== ch.dataset.valor);
        pagina = 1; return pintar();
      }
      if (e.target.closest('[data-limpiar]')) { const qq = est.q; est = vacio(); est.q = qq; pagina = 1; return pintar(); }
      const at = e.target.closest('[data-atajo]');
      if (at) { est = { ...vacio(), ...ATAJOS[Number(at.dataset.atajo)][1] }; q.value = ''; pagina = 1; return pintar(); }
      const rec = e.target.closest('[data-reciente]');
      if (rec) { q.value = rec.dataset.reciente; est.q = rec.dataset.reciente; pagina = 1; return pintar(); }
      if (e.target.closest('#bq-ver-mas')) { pagina++; return pintar(); }
      const exp = e.target.closest('#bq-exportar, #bq-zip');
      if (exp) {
        const zip = exp.id === 'bq-zip';
        const ids = JSON.parse($b('bq-resultados').dataset.ids || '[]');
        if (zip && ids.length > 150 && !confirm(`Se incluirán las resoluciones de los primeros 150 de ${ids.length} resultados. ¿Continuar?`)) return;
        await descargarLista(exp, zip ? '/api/buscar/resoluciones.zip' : '/api/buscar/excel', ids,
          `${zip ? 'resoluciones' : 'busqueda'}_${new Date().toISOString().slice(0, 10)}.${zip ? 'zip' : 'xlsx'}`);
      }
    });
    zona.addEventListener('change', e => { if (e.target.id === 'bq-orden') { est.orden = e.target.value; pagina = 1; pintar(); } });

    // búsqueda compartida por enlace: abre la sección con el mismo estado
    if (leerUrl()) {
      q.value = est.q;
      const abrir = () => document.querySelector('.tab-btn[data-tab="busqueda"]')?.click();
      setTimeout(abrir, 400);
    }
  });
})();

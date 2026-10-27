/* ═══════════════════════════════════════════════
   Portada · Panorama histórico de permisos
   Cifras clave, evolución anual, Chile de norte a sur y temáticas × año.
   HTML/CSS puro (sin Chart.js) para tener control fino de marcas y tooltips.
   Usa de app.js: STATE, IDS_INVESTIGACION, IDS_FILMACION, REGIONES_CHILE,
   TEMAS_INV, TEMAS_FILM, clasificarTramite, consolidarTemasPequenos, _normInv.
   ═══════════════════════════════════════════════ */
'use strict';

const PANO = {
  inv:  { label: 'Investigación',          color: 'var(--pano-inv)' },
  film: { label: 'Filmación y fotografía', color: 'var(--pano-film)' },
};

const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const _fmt = n => Number(n).toLocaleString('es-CL');
const _pct = (a, b) => b ? Math.round(a / b * 100) : 0;

// ─── Preparación de datos ─────────────────────────────────────────────────────
function _prepararPanorama(hist) {
  const anioActual = new Date().getFullYear();
  const regs = hist.map(t => {
    const anio = parseInt(String(t.fecha_inicio || '').slice(0, 4), 10);
    const tipo = IDS_INVESTIGACION.has(t.proceso_id) ? 'inv' : IDS_FILMACION.has(t.proceso_id) ? 'film' : null;
    return { t, anio, tipo };
  }).filter(r => r.tipo && r.anio >= 2000 && r.anio <= anioActual);

  // Años con datos suficientes (descarta años sueltos al inicio, p. ej. 3 registros en 2019)
  const conteoAnio = {};
  regs.forEach(r => { conteoAnio[r.anio] = (conteoAnio[r.anio] || 0) + 1; });
  const total = regs.length;
  let anios = Object.keys(conteoAnio).map(Number).sort((a, b) => a - b);
  while (anios.length > 1 && conteoAnio[anios[0]] < total * 0.01) anios.shift();
  const desde = anios[0];
  const datos = regs.filter(r => r.anio >= desde);
  anios = [];
  for (let y = desde; y <= anioActual; y++) anios.push(y);

  return { datos, anios, anioActual };
}

// ─── Componentes ──────────────────────────────────────────────────────────────
function _sparkline(valores, color) {
  const w = 120, h = 32, max = Math.max(...valores, 1);
  const pts = valores.map((v, i) => [i / (valores.length - 1 || 1) * (w - 6) + 3, h - 4 - v / max * (h - 8)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="pano-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${d} L ${w - 3} ${h} L 3 ${h} Z" fill="${color}" opacity=".1"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
  </svg>`;
}

function _card(id, titulo, subtitulo, cuerpo, tabla, extraClase = '') {
  return `<section class="pano-card ${extraClase}" id="${id}">
    <header class="pano-head">
      <div><h3>${titulo}</h3>${subtitulo ? `<p>${subtitulo}</p>` : ''}</div>
      <button class="pano-vista" data-card="${id}" aria-pressed="false">Ver tabla</button>
    </header>
    <div class="pano-body pano-grafico">${cuerpo}</div>
    <div class="pano-body pano-tabla" hidden>${tabla}</div>
  </section>`;
}

function _tablaHtml(cabecera, filas) {
  return `<div class="table-wrapper"><table class="pano-table">
    <thead><tr>${cabecera.map(c => `<th>${_esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${filas.map(f => `<tr>${f.map((c, i) => `<td${i ? ' class="num"' : ''}>${typeof c === 'number' ? _fmt(c) : _esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

const _leyenda = () => `<div class="pano-legend">
  <button class="pano-ley${_panMarca('tipo', 'inv')}" data-pfil="tipo|inv" aria-pressed="${PAN_FILTRO.tipo.has('inv')}"><i style="background:${PANO.inv.color}"></i>${PANO.inv.label}</button>
  <button class="pano-ley${_panMarca('tipo', 'film')}" data-pfil="tipo|film" aria-pressed="${PAN_FILTRO.tipo.has('film')}"><i style="background:${PANO.film.color}"></i>${PANO.film.label}</button>
</div>`;

// 1) Cifras clave
function _kpis({ datos, anios, anioActual }) {
  const porAnio = tipo => anios.map(y => datos.filter(r => r.anio === y && (!tipo || r.tipo === tipo)).length);
  const inv = datos.filter(r => r.tipo === 'inv');
  const film = datos.filter(r => r.tipo === 'film');
  const personas = new Set(inv.map(r => _normInv(r.t.nombre_solicitante)).filter(Boolean));
  const regiones = new Set(datos.flatMap(r => r.t.regiones_list || []));
  const totAnio = porAnio();
  const ultimoCompleto = totAnio[totAnio.length - 2] || 0;
  const tile = (label, valor, detalle, serie, color, fil) => `
    <div class="pano-kpi${fil ? _panMarca('tipo', fil) : ''}"${fil ? ` data-pfil="tipo|${fil}" role="button" tabindex="0" aria-pressed="${PAN_FILTRO.tipo.has(fil)}"` : ''}>
      <div class="pano-kpi-label">${label}</div>
      <div class="pano-kpi-value">${valor}</div>
      <div class="pano-kpi-foot"><span>${detalle}</span>${serie ? _sparkline(serie, color) : ''}</div>
    </div>`;
  return `<div class="pano-kpis">
    ${tile('Permisos otorgados', _fmt(datos.length), `desde ${anios[0]} · ${_fmt(ultimoCompleto)} en ${anioActual - 1}`, totAnio, 'var(--em-800)')}
    ${tile('Investigación', _fmt(inv.length), `${_pct(inv.length, datos.length)}% del total`, porAnio('inv'), PANO.inv.color, 'inv')}
    ${tile('Filmación y fotografía', _fmt(film.length), `${_pct(film.length, datos.length)}% del total`, porAnio('film'), PANO.film.color, 'film')}
    ${tile('Investigadores/as', _fmt(personas.size), `${_fmt(regiones.size)} de 16 regiones con actividad`, null)}
  </div>`;
}

// 2) Permisos por año (columnas apiladas)
function _evolucion({ datos, anios, anioActual }) {
  const filas = anios.map(y => {
    const inv = datos.filter(r => r.anio === y && r.tipo === 'inv').length;
    const film = datos.filter(r => r.anio === y && r.tipo === 'film').length;
    return { y, inv, film, tot: inv + film };
  });
  const max = Math.max(...filas.map(f => f.tot), 1);
  const pico = filas.reduce((a, b) => (b.tot > a.tot ? b : a));
  const cols = filas.map(f => {
    const enCurso = f.y === anioActual;
    const tip = `<strong>${f.y}${enCurso ? ' (en curso)' : ''}</strong><br>${PANO.inv.label}: ${_fmt(f.inv)}<br>${PANO.film.label}: ${_fmt(f.film)}<br>Total: ${_fmt(f.tot)}`;
    return `<div class="pano-col${enCurso ? ' en-curso' : ''}${_panMarca('anio', String(f.y))}" data-tip="${_esc(tip + '<br><small>Clic para ver estos permisos abajo</small>')}" tabindex="0" role="button" data-pfil="anio|${f.y}" aria-pressed="${PAN_FILTRO.anio.has(String(f.y))}">
      <div class="pano-col-val">${_fmt(f.tot)}</div>
      <div class="pano-col-stack" style="height:${f.tot / max * 100}%">
        <div class="seg" style="flex:${f.film};background:${PANO.film.color}"></div>
        <div class="seg" style="flex:${f.inv};background:${PANO.inv.color}"></div>
      </div>
      <div class="pano-col-lbl">${f.y}${enCurso ? '*' : ''}</div>
    </div>`;
  }).join('');
  const cuerpo = `${_leyenda()}<div class="pano-cols">${cols}</div>
    <p class="pano-nota">* Año en curso. Máximo en ${pico.y} con ${_fmt(pico.tot)} permisos.</p>`;
  const tabla = _tablaHtml(['Año', 'Investigación', 'Filmación y fotografía', 'Total'],
    filas.map(f => [String(f.y), f.inv, f.film, f.tot]));
  return _card('pano-evolucion', 'Permisos por año', 'Solicitudes aprobadas o en curso, según fecha de inicio', cuerpo, tabla);
}

// 3) Chile de norte a sur
function _regiones({ datos }) {
  const filas = REGIONES_CHILE.map(({ codigo, nombre }) => {
    const enRegion = datos.filter(r => (r.t.regiones_list || []).includes(nombre));
    const inv = enRegion.filter(r => r.tipo === 'inv').length;
    const film = enRegion.filter(r => r.tipo === 'film').length;
    return { codigo, nombre, inv, film, tot: inv + film };
  });
  const max = Math.max(...filas.map(f => f.tot), 1);
  const top = [...filas].sort((a, b) => b.tot - a.tot)[0];
  const barras = filas.map(f => {
    const tip = `<strong>${f.nombre}</strong><br>${PANO.inv.label}: ${_fmt(f.inv)}<br>${PANO.film.label}: ${_fmt(f.film)}`;
    return `<div class="pano-reg${_panMarca('region', f.nombre)}" data-tip="${_esc(tip + '<br><small>Clic para ver estos permisos abajo</small>')}" tabindex="0" role="button" data-pfil="region|${_esc(f.nombre)}" aria-pressed="${PAN_FILTRO.region.has(f.nombre)}">
      <span class="pano-reg-cod">${f.codigo}</span>
      <span class="pano-reg-nom">${f.nombre}</span>
      <span class="pano-reg-bar">
        <span class="seg" style="width:${f.inv / max * 100}%;background:${PANO.inv.color}"></span><span class="seg" style="width:${f.film / max * 100}%;background:${PANO.film.color}"></span>
        <em>${_fmt(f.tot)}</em>
      </span>
    </div>`;
  }).join('');
  const cuerpo = `${_leyenda()}<div class="pano-regs"><div class="pano-norte">Norte ↑</div>${barras}<div class="pano-norte">Sur ↓</div></div>
    <p class="pano-nota">Un permiso puede abarcar varias regiones. Mayor actividad: ${top.nombre} (${_fmt(top.tot)}).</p>`;
  const tabla = _tablaHtml(['Región', 'Investigación', 'Filmación y fotografía', 'Total'],
    filas.map(f => [f.nombre, f.inv, f.film, f.tot]));
  return _card('pano-regiones', 'Chile de norte a sur', 'Permisos por región, en orden geográfico', cuerpo, tabla);
}

// 4) Temáticas × año (mapa de calor)
function _temasPorAnio({ datos, anios, anioActual }, tipo) {
  const sub = datos.filter(r => r.tipo === tipo);
  const porSimilitud = _panSimilitud[tipo] || new Set();
  const consolidado = new Map();
  sub.forEach(r => {
    if (!consolidado.has(r.tema)) consolidado.set(r.tema, []);
    consolidado.get(r.tema).push(r);
  });
  const otros = consolidado.get('Otros') || [];
  consolidado.delete('Otros');
  const temas = [...consolidado.entries()].sort((a, b) => b[1].length - a[1].length);
  if (otros.length) temas.push(['Otros', otros]);

  const celdas = temas.map(([tema, rs]) => anios.map(y => rs.filter(r => r.anio === y).length));
  const maxCelda = Math.max(...celdas.flat(), 1);
  const maxTot = Math.max(...temas.map(([, rs]) => rs.length), 1);
  const nivel = v => v === 0 ? 0 : Math.min(5, 1 + Math.floor(Math.sqrt(v / maxCelda) * 5));

  const cab = `<div class="hm-row hm-head"><div class="hm-tema"></div>${anios.map(y => `<div class="hm-y${_panMarca('anio', String(y))}" data-pfil="anio|${y}" role="button" tabindex="0" title="Ver permisos de ${y}">${String(y).slice(2)}${y === anioActual ? '*' : ''}</div>`).join('')}<div class="hm-tot">Total</div></div>`;
  const filas = temas.map(([tema, rs], i) => {
    const esOtros = tema === 'Otros';
    const cells = celdas[i].map((v, j) => {
      const tip = `<strong>${_esc(tema)}</strong> · ${anios[j]}<br>${_fmt(v)} permiso${v === 1 ? '' : 's'}${v ? '<br><small>Clic para ver estos permisos abajo</small>' : ''}`;
      const sel = PAN_FILTRO.tema.has(`${tipo}|${tema}`) && PAN_FILTRO.anio.has(String(anios[j]));
      return `<div class="hm-c ${esOtros ? 'hm-gris' : `hm-${tipo}`} n${nivel(v)}${sel ? ' hm-sel' : ''}" data-tip="${_esc(tip)}"${v ? ` data-pcelda="${_esc(tipo + '|' + tema)}|${anios[j]}" role="button" tabindex="0"` : ''}></div>`;
    }).join('');
    const ult = celdas[i].slice(-3, -1).reduce((a, b) => a + b, 0);   // 2 últimos años completos
    const ant = celdas[i].slice(-5, -3).reduce((a, b) => a + b, 0);   // 2 años previos
    const tend = ant >= 5 ? Math.round((ult - ant) / ant * 100) : null;
    const flecha = tend === null ? '' : tend >= 15 ? `<span class="hm-tend up" title="${tend}% vs. bienio anterior">▲</span>`
                 : tend <= -15 ? `<span class="hm-tend down" title="${tend}% vs. bienio anterior">▼</span>` : '';
    return `<div class="hm-row${esOtros ? ' hm-otros' : ''}">
      <div class="hm-tema${_panMarca('tema', `${tipo}|${tema}`)}" title="Ver permisos de «${_esc(tema)}»" data-pfil="tema|${_esc(tipo + '|' + tema)}" role="button" tabindex="0" aria-pressed="${PAN_FILTRO.tema.has(`${tipo}|${tema}`)}">${esOtros ? 'Sin clasificar' : _esc(tema)}${flecha}</div>${cells}
      <div class="hm-tot"><span class="hm-bar ${esOtros ? 'hm-gris' : `hm-${tipo}`}" style="width:${rs.length / maxTot * 100}%"></span><em>${_fmt(rs.length)}</em></div>
    </div>`;
  }).join('');

  const escala = `<div class="hm-escala"><span>Menos</span>${[1, 2, 3, 4, 5].map(n => `<i class="hm-c hm-${tipo} n${n}"></i>`).join('')}<span>Más</span>
    <span class="hm-sep"></span><span>▲▼ variación ≥15% de ${anios[anios.length - 3]}–${String(anios[anios.length - 2]).slice(2)} vs. ${anios[anios.length - 5]}–${String(anios[anios.length - 4]).slice(2)}</span></div>`;
  const cuerpo = `${escala}<div class="hm" style="--hm-cols:${anios.length}">${cab}${filas}</div>
    <p class="pano-nota">Clasificación automática según título y objetivos del proyecto: ${_pct(sub.length - porSimilitud.size, sub.length)}% por palabras clave y ${_fmt(porSimilitud.size)} trámites por similitud con permisos ya clasificados.</p>`;
  const tabla = _tablaHtml(['Temática', ...anios.map(String), 'Total'],
    temas.map(([tema, rs], i) => [tema === 'Otros' ? 'Sin clasificar' : tema, ...celdas[i], rs.length]));
  const titulo = tipo === 'inv' ? 'Temáticas de investigación en el tiempo' : 'Tipos de filmación y fotografía en el tiempo';
  const subt = tipo === 'inv' ? 'Permisos por temática y año · intensidad = cantidad' : 'Solicitudes por tipo de producción y año';
  return _card(`pano-temas-${tipo}`, titulo, subt, cuerpo, tabla, 'pano-wide');
}

// ─── Tooltip y alternancia gráfico / tabla ────────────────────────────────────
function _activarInteraccion(root) {
  let tip = document.getElementById('pano-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'pano-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  const mostrar = (el, x, y) => {
    tip.innerHTML = el.dataset.tip;
    tip.classList.add('on');
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + 'px';
    tip.style.top = Math.max(8, y - r.height - 14) + 'px';
  };
  root.addEventListener('mousemove', e => {
    const el = e.target.closest('[data-tip]');
    if (el) mostrar(el, e.clientX, e.clientY); else tip.classList.remove('on');
  });
  root.addEventListener('mouseleave', () => tip.classList.remove('on'));
  root.addEventListener('focusin', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    mostrar(el, r.left + r.width / 2, r.top);
  });
  root.addEventListener('focusout', () => tip.classList.remove('on'));
  root.addEventListener('click', e => {
    const b = e.target.closest('.pano-vista');
    if (!b) return;
    const card = document.getElementById(b.dataset.card);
    const verTabla = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(verTabla));
    b.textContent = verTabla ? 'Ver gráfico' : 'Ver tabla';
    card.querySelector('.pano-grafico').hidden = verTabla;
    card.querySelector('.pano-tabla').hidden = !verTabla;
  });
}

// ─── Gráficos que filtran (vistas coordinadas, igual que en Desempeño) ───────
// Cada año, tipo, región, temática o celda del mapa de calor es un botón que filtra la
// tabla «Permisos de la selección». Entre gráficos: «y»; dentro de un gráfico: «o».
// Cada gráfico se calcula con los filtros de los demás, así sus números muestran lo que queda.
const PAN_FILTRO = { tipo: new Set(), anio: new Set(), region: new Set(), tema: new Set() };
const _panSimilitud = {};
let _panCtx = null, _panPag = 1, _panHist = null;

function _panMarca(dim, valor) {
  const f = PAN_FILTRO[dim];
  return !f.size ? '' : f.has(valor) ? ' fil-sel' : ' fil-off';
}

function _panPasa(r, sin = []) {
  const k = { tipo: [r.tipo], anio: [String(r.anio)], region: r.t.regiones_list || [], tema: [`${r.tipo}|${r.tema}`] };
  return Object.keys(PAN_FILTRO).every(d => sin.includes(d) || !PAN_FILTRO[d].size || k[d].some(v => PAN_FILTRO[d].has(v)));
}

// Temática de cada permiso (una sola vez; igual criterio que antes: palabras clave + similitud,
// y en investigación se agrupan los temas pequeños)
function _panClasificar(ctx) {
  ['inv', 'film'].forEach(tipo => {
    const sub = ctx.datos.filter(r => r.tipo === tipo);
    const { temas: temaDe, porSimilitud } = clasificarConjunto(sub.map(r => r.t));
    _panSimilitud[tipo] = porSimilitud;
    const porTema = new Map();
    sub.forEach(r => {
      const tema = temaDe.get(r.t.id) || 'Otros';
      if (!porTema.has(tema)) porTema.set(tema, []);
      porTema.get(tema).push(r);
    });
    const consolidado = tipo === 'inv' ? consolidarTemasPequenos(porTema, Math.max(8, sub.length * 0.01)) : porTema;
    consolidado.forEach((rs, tema) => rs.forEach(r => { r.tema = tema; }));
  });
}

function _panTabla(lista, total) {
  const chips = Object.entries(PAN_FILTRO).flatMap(([dim, f]) => [...f].map(v => {
    const txt = dim === 'tipo' ? PANO[v].label : dim === 'tema' ? v.split('|')[1].replace(/^Otros$/, 'Sin clasificar') : v;
    return `<button class="res-chip" data-pfil="${dim}|${_esc(v)}">${_esc(txt)} <span aria-hidden="true">✕</span></button>`;
  })).join('');
  const orden = [...lista].sort((a, b) => ((b.t.fecha_inicio || '') > (a.t.fecha_inicio || '') ? 1 : -1));
  const vis = orden.slice(0, _panPag * 25);
  const puedeExportar = (window.PERFIL?.secciones || []).includes('exportar');
  return `<section class="pano-card res-tabla-card" id="pano-tabla">
    <header class="pano-head"><div><h3>Permisos de la selección</h3>
      <p>${chips ? `${_fmt(lista.length)} de ${_fmt(total)} permisos con los filtros elegidos en los gráficos` : `${_fmt(total)} permisos · haga clic en un año, región, temática o celda de los gráficos para ver aquí esos permisos`}</p></div>
      ${puedeExportar && chips && lista.length ? `<div class="res-tabla-acc"><button class="pano-vista" data-pan-exp="excel">Exportar a Excel</button><button class="pano-vista" data-pan-exp="zip">Resoluciones (ZIP)</button></div>` : ''}
    </header>
    ${chips ? `<div class="res-chips">${chips}<button class="res-limpiar" data-pan-limpiar>Limpiar</button></div>` : ''}
    ${!chips ? '' : lista.length ? `<div class="table-wrapper"><table class="pano-table res-tabla">
      <thead><tr><th>ID</th><th>Tipo</th><th>Solicitante</th><th>Proyecto</th><th>Temática</th><th>Regiones</th><th>Inicio</th></tr></thead>
      <tbody>${vis.map(r => `<tr data-abrir="${r.t.id}" tabindex="0">
        <td class="res-td-id">#${r.t.id}</td>
        <td><span class="res-sit"><i style="background:${PANO[r.tipo].color}"></i>${r.tipo === 'inv' ? 'Investigación' : 'Filmación'}</span></td>
        <td>${_esc(r.t.nombre_solicitante || '–')}</td>
        <td class="res-td-tit" title="${_esc(_tituloTramite(r.t) || r.t.titulo_investigacion || '')}">${_esc(_tituloTramite(r.t) || r.t.titulo_investigacion || '–')}</td>
        <td>${_esc(r.tema === 'Otros' ? 'Sin clasificar' : r.tema || '–')}</td>
        <td>${_esc((r.t.regiones_list || []).join(', ') || '–')}</td>
        <td>${r.t.fecha_inicio ? formatDate(r.t.fecha_inicio) : r.anio}</td></tr>`).join('')}</tbody>
    </table></div>
    ${orden.length > vis.length ? `<button class="res-ver-mas" data-pan-mas>Ver ${Math.min(25, orden.length - vis.length)} más de ${_fmt(orden.length - vis.length)}</button>` : ''}`
    : '<div class="empty-msg">Ningún permiso cumple todos los filtros. Quite alguno.</div>'}
  </section>`;
}

function _panSyncEntregadas() {
  if (!window.renderTablaEntregadas) return;
  const invTemas = [...PAN_FILTRO.tema].filter(v => v.startsWith('inv|')).map(v => v.slice(4));
  const tema = invTemas[0] || '';
  window.renderTablaEntregadas(tema);
  window.setFiltroGaleria?.(tema);
}

function _panClic(e) {
  const root = e.currentTarget;
  const abrir = e.target.closest('tr[data-abrir]');
  if (abrir) return openModal(Number(abrir.dataset.abrir));
  if (e.target.closest('[data-pan-mas]')) { _panPag++; return _panPintar(true); }
  if (e.target.closest('[data-pan-limpiar]')) {
    Object.values(PAN_FILTRO).forEach(f => f.clear());
    _panPag = 1;
    _panPintar(true);
    _panSyncEntregadas();
    return;
  }
  const exp = e.target.closest('[data-pan-exp]');
  if (exp && window.descargarListaTramites) {
    const ids = JSON.parse(root.dataset.ids || '[]');
    const zip = exp.dataset.panExp === 'zip';
    if (zip && ids.length > 150 && !confirm(`Se incluirán las resoluciones de los primeros 150 de ${ids.length} permisos. ¿Continuar?`)) return;
    return window.descargarListaTramites(exp, zip ? '/api/buscar/resoluciones.zip' : '/api/buscar/excel', ids,
      `${zip ? 'resoluciones' : 'permisos'}_${new Date().toISOString().slice(0, 10)}.${zip ? 'zip' : 'xlsx'}`);
  }
  const celda = e.target.closest('[data-pcelda]');
  if (celda) {                                       // celda del mapa de calor = temática + año
    const partes = celda.dataset.pcelda.split('|');
    const tema = `${partes[0]}|${partes[1]}`, anio = partes[2];
    const ya = PAN_FILTRO.tema.has(tema) && PAN_FILTRO.anio.has(anio);
    if (ya) { PAN_FILTRO.tema.delete(tema); PAN_FILTRO.anio.delete(anio); } else { PAN_FILTRO.tema.add(tema); PAN_FILTRO.anio.add(anio); }
    _panPag = 1;
    _panPintar(true, true);
    _panSyncEntregadas();
    return;
  }
  const fil = e.target.closest('[data-pfil]');
  if (fil) {
    const [dim, ...resto] = fil.dataset.pfil.split('|');
    const valor = resto.join('|');
    const f = PAN_FILTRO[dim];
    if (f.has(valor)) f.delete(valor); else f.add(valor);
    _panPag = 1;
    _panPintar(true, !fil.classList.contains('res-chip'));
    if (dim === 'tema') _panSyncEntregadas();
  }
}

function _panPintar(repintado = false, irATabla = false) {
  const root = document.getElementById('panorama');
  const ctx = _panCtx;
  const sin = dims => ({ ...ctx, datos: ctx.datos.filter(r => _panPasa(r, dims)) });
  const filtrados = ctx.datos.filter(r => _panPasa(r));
  root.dataset.ids = JSON.stringify(filtrados.map(r => r.t.id));
  const y = window.scrollY;
  root.innerHTML = `
    ${_kpis({ ...ctx, datos: filtrados })}
    <div class="pano-grid">${_evolucion(sin(['anio', 'tipo']))}${_regiones(sin(['region']))}</div>
    ${_temasPorAnio(sin(['tema', 'anio', 'tipo']), 'inv')}
    ${_temasPorAnio(sin(['tema', 'anio', 'tipo']), 'film')}
    ${_panTabla(filtrados, ctx.datos.length)}`;
  if (repintado) window.scrollTo({ top: y });
  if (irATabla && Object.values(PAN_FILTRO).some(f => f.size)) {
    const tabla = document.getElementById('pano-tabla');
    const r = tabla.getBoundingClientRect();
    if (r.top > window.innerHeight - 120) {           // la tabla queda fuera de la vista: un aviso para bajar
      _panAviso(tabla);
    }
  }
}

function _panAviso(tabla) {
  let a = document.getElementById('pano-aviso');
  if (!a) {
    a = Object.assign(document.createElement('button'), { id: 'pano-aviso', className: 'pano-aviso' });
    a.addEventListener('click', () => { document.getElementById('pano-tabla')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); a.remove(); });
    document.body.appendChild(a);
  }
  a.textContent = `Ver los ${JSON.parse(document.getElementById('panorama').dataset.ids || '[]').length} permisos seleccionados ↓`;
  clearTimeout(a._t);
  a._t = setTimeout(() => a.remove(), 6000);
}

// ─── Entrada ──────────────────────────────────────────────────────────────────
function renderPanorama(hist) {
  const root = document.getElementById('panorama');
  if (!root) return;
  const ctx = _prepararPanorama(hist);
  if (!ctx.datos.length) {
    root.innerHTML = '<div class="empty-msg">Sin datos históricos disponibles.</div>';
    return;
  }
  if (hist !== _panHist) { Object.values(PAN_FILTRO).forEach(f => f.clear()); _panPag = 1; _panHist = hist; }
  _panClasificar(ctx);
  _panCtx = ctx;
  _panPintar();
  if (!root.dataset.listo) {
    _activarInteraccion(root);
    root.addEventListener('click', _panClic);
    root.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.closest('[data-pfil], [data-pcelda], tr[data-abrir]')) { e.preventDefault(); e.target.click(); }
    });
    document.addEventListener('entregadas-tema', e => {
      Object.values(PAN_FILTRO).forEach(f => f.clear());
      const tema = e.detail.tema;
      if (tema) PAN_FILTRO.tema.add(`inv|${tema}`);
      _panPag = 1;
      _panPintar(true);
    });
    root.dataset.listo = '1';
  }
}

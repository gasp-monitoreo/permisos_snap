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
  <span><i style="background:${PANO.inv.color}"></i>${PANO.inv.label}</span>
  <span><i style="background:${PANO.film.color}"></i>${PANO.film.label}</span>
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
  const tile = (label, valor, detalle, serie, color) => `
    <div class="pano-kpi">
      <div class="pano-kpi-label">${label}</div>
      <div class="pano-kpi-value">${valor}</div>
      <div class="pano-kpi-foot"><span>${detalle}</span>${serie ? _sparkline(serie, color) : ''}</div>
    </div>`;
  return `<div class="pano-kpis">
    ${tile('Permisos otorgados', _fmt(datos.length), `desde ${anios[0]} · ${_fmt(ultimoCompleto)} en ${anioActual - 1}`, totAnio, 'var(--em-800)')}
    ${tile('Investigación', _fmt(inv.length), `${_pct(inv.length, datos.length)}% del total`, porAnio('inv'), PANO.inv.color)}
    ${tile('Filmación y fotografía', _fmt(film.length), `${_pct(film.length, datos.length)}% del total`, porAnio('film'), PANO.film.color)}
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
    return `<div class="pano-col${enCurso ? ' en-curso' : ''}" data-tip="${_esc(tip)}" tabindex="0">
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
    return `<div class="pano-reg" data-tip="${_esc(tip)}" tabindex="0">
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
  const lista = tipo === 'inv' ? TEMAS_INV : TEMAS_FILM;
  const sub = datos.filter(r => r.tipo === tipo);
  const { temas: temaDe, porSimilitud } = clasificarConjunto(sub.map(r => r.t));
  const porTema = new Map();
  sub.forEach(r => {
    const tema = temaDe.get(r.t.id) || 'Otros';
    if (!porTema.has(tema)) porTema.set(tema, []);
    porTema.get(tema).push(r);
  });
  const consolidado = tipo === 'inv' ? consolidarTemasPequenos(porTema, Math.max(8, sub.length * 0.01)) : porTema;
  const otros = consolidado.get('Otros') || [];
  consolidado.delete('Otros');
  const temas = [...consolidado.entries()].sort((a, b) => b[1].length - a[1].length);
  if (otros.length) temas.push(['Otros', otros]);

  const celdas = temas.map(([tema, rs]) => anios.map(y => rs.filter(r => r.anio === y).length));
  const maxCelda = Math.max(...celdas.flat(), 1);
  const maxTot = Math.max(...temas.map(([, rs]) => rs.length), 1);
  const nivel = v => v === 0 ? 0 : Math.min(5, 1 + Math.floor(Math.sqrt(v / maxCelda) * 5));

  const cab = `<div class="hm-row hm-head"><div class="hm-tema"></div>${anios.map(y => `<div class="hm-y">${String(y).slice(2)}${y === anioActual ? '*' : ''}</div>`).join('')}<div class="hm-tot">Total</div></div>`;
  const filas = temas.map(([tema, rs], i) => {
    const esOtros = tema === 'Otros';
    const cells = celdas[i].map((v, j) => {
      const tip = `<strong>${_esc(tema)}</strong> · ${anios[j]}<br>${_fmt(v)} permiso${v === 1 ? '' : 's'}`;
      return `<div class="hm-c ${esOtros ? 'hm-gris' : `hm-${tipo}`} n${nivel(v)}" data-tip="${_esc(tip)}"></div>`;
    }).join('');
    const ult = celdas[i].slice(-3, -1).reduce((a, b) => a + b, 0);   // 2 últimos años completos
    const ant = celdas[i].slice(-5, -3).reduce((a, b) => a + b, 0);   // 2 años previos
    const tend = ant >= 5 ? Math.round((ult - ant) / ant * 100) : null;
    const flecha = tend === null ? '' : tend >= 15 ? `<span class="hm-tend up" title="${tend}% vs. bienio anterior">▲</span>`
                 : tend <= -15 ? `<span class="hm-tend down" title="${tend}% vs. bienio anterior">▼</span>` : '';
    return `<div class="hm-row${esOtros ? ' hm-otros' : ''}">
      <div class="hm-tema" title="${_esc(tema)}">${esOtros ? 'Sin clasificar' : _esc(tema)}${flecha}</div>${cells}
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

// ─── Entrada ──────────────────────────────────────────────────────────────────
function renderPanorama(hist) {
  const root = document.getElementById('panorama');
  if (!root) return;
  const ctx = _prepararPanorama(hist);
  if (!ctx.datos.length) {
    root.innerHTML = '<div class="empty-msg">Sin datos históricos disponibles.</div>';
    return;
  }
  root.innerHTML = `
    ${_kpis(ctx)}
    <div class="pano-grid">${_evolucion(ctx)}${_regiones(ctx)}</div>
    ${_temasPorAnio(ctx, 'inv')}
    ${_temasPorAnio(ctx, 'film')}`;
  if (!root.dataset.listo) {
    _activarInteraccion(root);
    root.dataset.listo = '1';
  }
}

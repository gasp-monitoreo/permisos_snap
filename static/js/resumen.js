/* ═══════════════════════════════════════════════
   Resumen · vista analítica del tipo activo (Investigación / Filmación)
   Estado, ingresos por mes, tiempo de resolución, bandeja de pendientes
   por responsable y regiones de norte a sur.
   Reutiliza de panorama.js: _card, _tablaHtml, _esc, _fmt, _pct, _activarInteraccion.
   ═══════════════════════════════════════════════ */
'use strict';

// Situación de cada solicitud (situacionTramite en app.js). Separa lo que depende de CONAF
// de lo que depende del solicitante o está suspendido, para no contarlo como atraso.
const RES_ESTADOS = [
  { key: 'completado',         label: 'Completadas',                                color: '#347A17', grupo: 'resuelta' },
  { key: 'cierre_solicitante', label: 'Resueltas, falta cierre del solicitante',    color: '#8DBF6A', grupo: 'resuelta' },
  { key: 'rechazado',          label: 'Rechazadas',                                 color: '#6B4A8C', grupo: 'resuelta' },
  { key: 'espera_solicitante', label: 'Pendiente del solicitante',                  color: '#3F7CB8', grupo: 'solicitante' },
  { key: 'suspendido',         label: 'En suspensión',                              color: '#8A8F98', grupo: 'suspendido' },
  { key: 'al_dia',             label: 'En trámite CONAF, al día',                   color: '#D9A13B', grupo: 'conaf' },
  { key: 'vencido',            label: 'Atraso de CONAF (plazo vencido)',            color: '#B9412F', grupo: 'conaf' },
];
const _COLOR = Object.fromEntries(RES_ESTADOS.map(e => [e.key, e.color]));
const _LABEL = Object.fromEntries(RES_ESTADOS.map(e => [e.key, e.label]));
const _MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const _DIA = 86400000;

const _estadoRes = t => situacionTramite(t);
// Resuelta por CONAF: completada, rechazada o con resolución emitida aunque el solicitante no cierre
const _resueltaConaf = t => ['completado', 'cierre_solicitante', 'rechazado'].includes(_estadoRes(t));
const _delSolicitante = k => k === 'espera_solicitante' || k === 'cierre_solicitante';
const _mediana = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const _percentil = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const _diasDesde = f => f ? Math.max(0, Math.floor((Date.now() - new Date(f)) / _DIA)) : null;
const _leyendaRes = keys => `<div class="pano-legend">${RES_ESTADOS.filter(e => keys.includes(e.key))
  .map(e => `<span><i style="background:${e.color}"></i>${e.label}</span>`).join('')}</div>`;
const _contar = ts => {
  const n = {};
  RES_ESTADOS.forEach(e => { n[e.key] = 0; });
  ts.forEach(t => { n[_estadoRes(t)]++; });
  return n;
};

// 1) Estado de las solicitudes: barra 100% con etiquetas
function _resEstado(ts, nombreTipo, region) {
  const n = _contar(ts);
  const total = ts.length || 1;
  const segs = RES_ESTADOS.filter(e => n[e.key]).map(e => {
    const p = n[e.key] / total * 100;
    const tip = `<strong>${e.label}</strong><br>${_fmt(n[e.key])} solicitudes · ${Math.round(p)}%`;
    return `<div class="res-seg" style="flex:${n[e.key]};background:${e.color}" data-tip="${_esc(tip)}" tabindex="0">
      ${p >= 9 ? `<span>${Math.round(p)}%</span>` : ''}</div>`;
  }).join('');
  const cifras = RES_ESTADOS.map(e => `
    <div class="res-cifra"><i style="background:${e.color}"></i>
      <strong>${_fmt(n[e.key])}</strong><span>${e.label}</span></div>`).join('');
  const resueltas = n.completado + n.cierre_solicitante + n.rechazado;
  const solic = n.cierre_solicitante + n.espera_solicitante;
  const notas = [
    `${_fmt(resueltas)} de ${_fmt(ts.length)} solicitudes de ${nombreTipo.toLowerCase()} ya fueron resueltas por CONAF (${_pct(resueltas, ts.length)}%).`,
    n.vencido ? `<strong>${_fmt(n.vencido)} con atraso de CONAF.</strong>` : 'Sin atrasos de CONAF.',
    solic ? `${_fmt(solic)} dependen del solicitante (${_fmt(n.cierre_solicitante)} solo deben cerrar el trámite en Cero Filas) y no se cuentan como atraso.` : '',
    n.suspendido ? `${_fmt(n.suspendido)} en suspensión.` : '',
  ].filter(Boolean).join(' ');
  const cuerpo = `<div class="res-barra">${segs}</div><div class="res-cifras">${cifras}</div><p class="pano-nota">${notas}</p>`;
  const tabla = _tablaHtml(['Situación', 'Solicitudes', '%'], RES_ESTADOS.map(e => [e.label, n[e.key], `${_pct(n[e.key], ts.length)}%`]));
  return _card('res-estado', 'Estado de las solicitudes',
    `${_fmt(ts.length)} solicitudes en el rango seleccionado${region ? ` · Región de ${_esc(region)}` : ''}`, cuerpo, tabla);
}

// 2) Ingresos por período (mes / trimestre / año según el rango), apilados por situación
function _resIngresos(ts, desde, hasta) {
  const anios = hasta - desde + 1;
  const modo = anios === 1 ? 'mes' : anios <= 3 ? 'trimestre' : 'anio';
  const clave = d => modo === 'mes' ? d.getMonth() : modo === 'trimestre' ? (d.getFullYear() - desde) * 4 + Math.floor(d.getMonth() / 3) : d.getFullYear() - desde;
  const nPer = modo === 'mes' ? 12 : modo === 'trimestre' ? anios * 4 : anios;
  const etiqueta = i => modo === 'mes' ? _MESES[i] : modo === 'trimestre' ? `T${i % 4 + 1} ${String(desde + Math.floor(i / 4)).slice(2)}` : String(desde + i);
  const hoy = new Date();
  const futuro = i => modo === 'mes' ? (desde === hoy.getFullYear() && i > hoy.getMonth())
    : modo === 'trimestre' ? (desde + Math.floor(i / 4) === hoy.getFullYear() && i % 4 > Math.floor(hoy.getMonth() / 3)) || desde + Math.floor(i / 4) > hoy.getFullYear()
    : desde + i > hoy.getFullYear();

  const vacio = () => Object.fromEntries(RES_ESTADOS.map(e => [e.key, 0]));
  const per = Array.from({ length: nPer }, vacio);
  ts.forEach(t => {
    if (!t.fecha_inicio) return;
    const i = clave(new Date(t.fecha_inicio));
    if (i < 0 || i >= nPer) return;
    per[i][_estadoRes(t)]++;
  });
  const tot = p => RES_ESTADOS.reduce((a, e) => a + p[e.key], 0);
  const presentes = RES_ESTADOS.filter(e => per.some(p => p[e.key])).map(e => e.key);
  const max = Math.max(...per.map(tot), 1);
  const validos = per.filter((_, i) => !futuro(i));
  const promedio = validos.reduce((a, p) => a + tot(p), 0) / Math.max(1, validos.length);
  const pico = per.reduce((b, p, i) => (tot(p) > b.v ? { v: tot(p), i } : b), { v: -1, i: 0 });

  const cols = per.map((p, i) => {
    const n = tot(p);
    const detalle = RES_ESTADOS.filter(e => p[e.key]).map(e => `${e.label}: ${_fmt(p[e.key])}`).join('<br>');
    const tip = `<strong>${etiqueta(i)}</strong><br>Ingresadas: ${_fmt(n)}${detalle ? `<br>${detalle}` : ''}`;
    // De arriba hacia abajo: lo más urgente arriba, lo resuelto en la base
    const segs = [...RES_ESTADOS].reverse().map(e => p[e.key] ? `<div class="seg" style="flex:${p[e.key]};background:${e.color}"></div>` : '').join('');
    return `<div class="pano-col${futuro(i) ? ' futuro' : ''}" data-tip="${_esc(tip)}" tabindex="0">
      <div class="pano-col-val">${n || ''}</div>
      <div class="pano-col-stack" style="height:${n / max * 100}%">${segs}</div>
      <div class="pano-col-lbl">${etiqueta(i)}</div>
    </div>`;
  }).join('');
  const unidad = modo === 'mes' ? 'mes' : modo === 'trimestre' ? 'trimestre' : 'año';
  const cuerpo = `${_leyendaRes(presentes)}
    <div class="pano-cols res-cols" style="--prom:${promedio / max * 100}%"><div class="res-prom" title="Promedio"><span>prom. ${promedio.toFixed(1).replace('.', ',')}</span></div>${cols}</div>
    <p class="pano-nota">Mayor ingreso: ${etiqueta(pico.i)} (${_fmt(pico.v)}). Promedio ${promedio.toFixed(1).replace('.', ',')} por ${unidad}.</p>`;
  const tabla = _tablaHtml(['Período', 'Ingresadas', ...RES_ESTADOS.map(e => e.label)],
    per.map((p, i) => [etiqueta(i), tot(p), ...RES_ESTADOS.map(e => p[e.key])]));
  return _card('res-ingresos', `Ingresos por ${unidad}`, 'Solicitudes según fecha de ingreso y su situación actual', cuerpo, tabla);
}

// 3) Tiempo de resolución (histograma): días hasta que CONAF resolvió
function _resTiempos(ts) {
  const resueltas = ts.filter(_resueltaConaf);
  const dias = resueltas.map(calcularDias).filter(d => d !== null);
  const sinCierre = resueltas.filter(t => _estadoRes(t) === 'cierre_solicitante').length;
  const tramos = [[0, 15, '≤ 15'], [16, 30, '16–30'], [31, 60, '31–60'], [61, 90, '61–90'], [91, 180, '91–180'], [181, Infinity, '> 180']];
  const n = tramos.map(([a, b]) => dias.filter(d => d >= a && d <= b).length);
  const max = Math.max(...n, 1);
  const med = _mediana(dias), p80 = _percentil(dias, 0.8);
  const en30 = dias.filter(d => d <= 30).length;
  const barras = tramos.map(([, , lbl], i) => {
    const tip = `<strong>${lbl} días</strong><br>${_fmt(n[i])} solicitudes · ${_pct(n[i], dias.length)}%`;
    return `<div class="res-hist-row" data-tip="${_esc(tip)}" tabindex="0">
      <span class="res-hist-lbl">${lbl} días</span>
      <span class="res-hist-bar"><span style="width:${n[i] / max * 100}%"></span><em>${_fmt(n[i])}</em></span>
    </div>`;
  }).join('');
  const cuerpo = dias.length ? `
    <div class="res-hero">
      <div><strong>${med}</strong><span>días de mediana</span></div>
      <div><strong>${_pct(en30, dias.length)}%</strong><span>resueltas en ≤ 30 días</span></div>
      <div><strong>${p80}</strong><span>días para resolver el 80%</span></div>
    </div>
    <div class="res-hist">${barras}</div>
    <p class="pano-nota">Desde la fecha de ingreso hasta que CONAF resolvió (${_fmt(dias.length)} solicitudes resueltas${sinCierre ? `; en ${_fmt(sinCierre)} el solicitante aún no cierra el trámite y el tiempo que tarde en hacerlo no se suma` : ''}).</p>`
    : '<div class="empty-msg">Aún no hay solicitudes resueltas en el rango.</div>';
  const tabla = _tablaHtml(['Tramo', 'Solicitudes', '%'], tramos.map(([, , l], i) => [`${l} días`, n[i], `${_pct(n[i], dias.length)}%`]));
  return _card('res-tiempos', 'Tiempo de resolución', 'Cuánto tarda CONAF en resolver las solicitudes', cuerpo, tabla);
}

// 4) Bandeja de pendientes por oficina regional del responsable
//    No se muestran personas: cada funcionario se asigna a la región que representa,
//    inferida de los trámites donde ha tenido etapas asignadas (región mayoritaria).
//    Lo que espera al solicitante va en filas aparte y nunca cuenta como atraso de CONAF.
const SIN_ASIGNAR = 'Sin responsable asignado';
const NIVEL_CENTRAL = 'Nivel central / varias regiones';
const EN_SOLICITANTE = 'Pendiente del solicitante';
const CIERRE_SOLICITANTE = 'Resueltas, falta cierre del solicitante';
const BANDEJA_KEYS = ['vencido', 'al_dia', 'suspendido', 'espera_solicitante', 'cierre_solicitante'];

function _regionesDeResponsables() {
  const conteo = new Map();   // clave responsable → {región: n}
  STATE.tramites.forEach(t => {
    const regs = t.regiones_list || [];
    if (regs.length !== 1) return;   // solo trámites de una región: señal inequívoca
    (t.etapas || []).forEach(e => {
      const clave = (e.email || e.nombres || '').toLowerCase();
      if (!clave || (e.email && !/@conaf\.(gob\.)?cl$/.test(clave))) return;   // solo funcionarios CONAF
      if (!conteo.has(clave)) conteo.set(clave, {});
      const c = conteo.get(clave);
      c[regs[0]] = (c[regs[0]] || 0) + 1;
    });
  });
  const region = new Map();
  conteo.forEach((c, clave) => {
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const [top, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    region.set(clave, n / total >= 0.6 ? top : NIVEL_CENTRAL);
  });
  return region;
}

function _resBandeja(ts) {
  const pend = ts.filter(t => BANDEJA_KEYS.includes(_estadoRes(t)));
  const regionDe = _regionesDeResponsables();
  const porOficina = new Map();
  pend.forEach(t => {
    const sit = _estadoRes(t);
    const ea = t.etapa_actual || {};
    const clave = (ea.email || ea.nombres || '').toLowerCase();
    const externo = ea.email && !/@conaf\.(gob\.)?cl$/i.test(ea.email);
    const oficina = sit === 'cierre_solicitante' ? CIERRE_SOLICITANTE
      : sit === 'espera_solicitante' || externo ? EN_SOLICITANTE
      : !clave ? SIN_ASIGNAR : (regionDe.get(clave) || NIVEL_CENTRAL);
    // Espera: desde que llegó a la etapa actual (o, si ya está resuelta, desde la resolución)
    const desde = sit === 'cierre_solicitante' ? (t.fecha_resolucion || t.fecha_modificacion) : (ea.fecha_inicio || t.fecha_inicio);
    if (!porOficina.has(oficina)) porOficina.set(oficina, { nombre: oficina, items: [] });
    porOficina.get(oficina).items.push({ t, sit, espera: _diasDesde(desde) });
  });
  const orden = REGIONES_CHILE.map(r => r.nombre);
  const delSolic = nombre => nombre === EN_SOLICITANTE || nombre === CIERRE_SOLICITANTE;
  const filas = [...porOficina.values()].map(r => {
    const c = Object.fromEntries(BANDEJA_KEYS.map(k => [k, r.items.filter(i => i.sit === k).length]));
    return {
      ...r, c,
      n: r.items.length,
      venc: c.vencido,
      max: Math.max(...r.items.map(i => i.espera || 0)),
      med: _mediana(r.items.map(i => i.espera || 0)),
      cod: (REGIONES_CHILE.find(x => x.nombre === r.nombre) || {}).codigo || '',
    };
  }).sort((a, b) => delSolic(a.nombre) - delSolic(b.nombre) || b.venc - a.venc || b.n - a.n || orden.indexOf(a.nombre) - orden.indexOf(b.nombre));
  if (!filas.length) {
    return _card('res-bandeja', 'Pendientes por oficina regional', 'Dónde están las solicitudes en espera', '<div class="empty-msg">No hay solicitudes pendientes 🎉</div>', '');
  }
  const conaf = filas.filter(f => !delSolic(f.nombre));
  const solic = filas.filter(f => delSolic(f.nombre));
  const visibles = [...conaf.slice(0, 10), ...solic];
  const maxN = Math.max(...filas.map(f => f.n), 1);
  const html = visibles.map((f, idx) => {
    const ids = f.items.sort((a, b) => (b.espera || 0) - (a.espera || 0)).slice(0, 6).map(i => `#${i.t.id} (${i.espera ?? '–'} d)`).join(', ');
    const detalle = BANDEJA_KEYS.filter(k => f.c[k]).map(k => `${f.c[k]} ${_LABEL[k].toLowerCase()}`).join('<br>');
    const tip = `<strong>${_esc(f.nombre)}</strong><br>${detalle}<br>Espera mediana ${f.med} d · máxima ${f.max} d<br><small>${_esc(ids)}</small>`;
    const segs = BANDEJA_KEYS.map(k => f.c[k] ? `<span class="seg" style="width:${f.c[k] / maxN * 100}%;background:${_COLOR[k]}"></span>` : '').join('');
    const sep = delSolic(f.nombre) && (idx === 0 || !delSolic(visibles[idx - 1].nombre)) && conaf.length
      ? '<div class="res-resp-sep">Fuera del control de CONAF</div>' : '';
    // La espera larga solo se marca en rojo cuando la etapa está en CONAF
    const alto = !delSolic(f.nombre) && f.max > 30;
    return `${sep}<div class="res-resp" data-tip="${_esc(tip)}" tabindex="0">
      <span class="res-resp-nom">${f.cod ? `<span class="reg-cod">${f.cod}</span> ` : ''}${_esc(f.nombre)}</span>
      <span class="res-resp-bar">${segs}<em>${f.n}</em></span>
      <span class="res-resp-espera ${alto ? 'alto' : ''}">${f.max} d</span>
    </div>`;
  }).join('');
  const presentes = BANDEJA_KEYS.filter(k => filas.some(f => f.c[k]));
  const nConaf = conaf.reduce((a, f) => a + f.n, 0);
  const nVenc = conaf.reduce((a, f) => a + f.venc, 0);
  const cuerpo = `<div class="pano-legend">${presentes.map(k => `<span><i style="background:${_COLOR[k]}"></i>${_LABEL[k]}</span>`).join('')}<span class="res-leg-espera">d = espera máxima</span></div>
    <div class="res-resps">${html}</div>
    <p class="pano-nota">${conaf.length > 10 ? 'Se muestran las 10 oficinas con más atrasos; el resto en la tabla. ' : ''}Oficina = región que representa el funcionario a cargo de la etapa actual. Espera contada desde que la solicitud llegó a esa etapa. Lo pendiente del solicitante (responder, subsanar o cerrar el trámite en Cero Filas) se muestra aparte y no es atraso de CONAF.</p>`;
  const tabla = _tablaHtml(['Oficina', 'Total', ...BANDEJA_KEYS.map(k => _LABEL[k]), 'Espera mediana (d)', 'Espera máxima (d)'],
    filas.map(f => [f.nombre, f.n, ...BANDEJA_KEYS.map(k => f.c[k]), f.med, f.max]));
  return _card('res-bandeja', 'Pendientes por oficina regional',
    `${_fmt(nConaf)} en CONAF${nVenc ? ` (${_fmt(nVenc)} con atraso)` : ''} · ${_fmt(pend.length - nConaf)} del solicitante`, cuerpo, tabla);
}

// 5) Regiones de norte a sur (matriz)
function _resRegiones(ts, regionActiva) {
  const filas = REGIONES_CHILE.map(({ codigo, nombre }) => {
    const r = ts.filter(t => (t.regiones_list || []).includes(nombre));
    const sit = r.map(_estadoRes);
    const cuenta = (...ks) => sit.filter(s => ks.includes(s)).length;
    return {
      codigo, nombre, n: r.length,
      tram: cuenta('al_dia', 'vencido'),
      venc: cuenta('vencido'),
      solic: cuenta('espera_solicitante', 'cierre_solicitante'),
      susp: cuenta('suspendido'),
      med: _mediana(r.filter(_resueltaConaf).map(calcularDias).filter(d => d !== null)),
    };
  });
  const maxN = Math.max(...filas.map(f => f.n), 1);
  const meds = filas.map(f => f.med).filter(m => m !== null);
  const maxMed = Math.max(...meds, 1);
  const nivel = m => m === null ? 0 : Math.min(5, 1 + Math.floor(m / maxMed * 4.99));
  const lenta = filas.filter(f => f.med !== null && f.n >= 3).sort((a, b) => b.med - a.med)[0];
  const cab = `<div class="res-reg res-reg-head"><span></span><span></span><span>Solicitudes</span><span>En CONAF</span><span title="Plazo vencido con la etapa en CONAF">Atraso CONAF</span><span title="Responder, subsanar o cerrar el trámite">Del solicitante</span><span>Suspendidas</span><span>Mediana resolución</span></div>`;
  const html = filas.map(f => {
    const tip = `<strong>${f.nombre}</strong><br>${f.n} solicitudes · ${f.tram} en trámite CONAF · ${f.venc} con atraso de CONAF<br>${f.solic} pendientes del solicitante · ${f.susp} en suspensión<br>Resolución mediana: ${f.med ?? '–'} días<br><small>Clic para filtrar el Resumen</small>`;
    const clase = regionActiva ? (f.nombre === regionActiva ? ' activa' : ' atenuada') : '';
    return `<div class="res-reg${clase}" data-tip="${_esc(tip)}" data-region="${_esc(f.nombre)}" tabindex="0" role="button">
      <span class="pano-reg-cod">${f.codigo}</span>
      <span class="pano-reg-nom">${f.nombre}</span>
      <span class="res-reg-bar"><span style="width:${f.n / maxN * 100}%"></span><em>${f.n}</em></span>
      <span class="res-reg-num">${f.tram || '·'}</span>
      <span class="res-reg-num ${f.venc ? 'venc' : ''}">${f.venc || '·'}</span>
      <span class="res-reg-num ${f.solic ? 'solic' : ''}">${f.solic || '·'}</span>
      <span class="res-reg-num ${f.susp ? 'susp' : ''}">${f.susp || '·'}</span>
      <span class="res-reg-med n${nivel(f.med)}">${f.med === null ? '–' : f.med + ' d'}</span>
    </div>`;
  }).join('');
  const cuerpo = `<div class="res-regs">${cab}${html}</div>
    <p class="pano-nota">Un permiso puede abarcar varias regiones. «Atraso CONAF» cuenta solo plazos vencidos con la etapa en CONAF; lo pendiente del solicitante y lo suspendido va aparte.${lenta ? ` Resolución más lenta: ${lenta.nombre} (${lenta.med} días de mediana).` : ''} Color de la mediana: más oscuro = más días.</p>`;
  const tabla = _tablaHtml(['Región', 'Solicitudes', 'En trámite CONAF', 'Atraso CONAF', 'Pendiente del solicitante', 'En suspensión', 'Mediana resolución (d)'],
    filas.map(f => [f.nombre, f.n, f.tram, f.venc, f.solic, f.susp, f.med ?? '–']));
  return _card('res-regiones', 'Regiones de norte a sur', 'Volumen, carga pendiente y velocidad de resolución', cuerpo, tabla);
}

// ─── Entrada ──────────────────────────────────────────────────────────────────
// ts: trámites del tipo ya filtrados por región · tsTipo: todas las regiones (para la matriz)
function renderResumenVisual(ts, tipo, tsTipo = ts, region = null) {
  const root = document.getElementById('resumen-visual');
  if (!root) return;
  const desde = parseInt(document.getElementById('rango-desde').value, 10);
  const hasta = parseInt(document.getElementById('rango-hasta').value, 10);
  const nombreTipo = tipo === 'film' ? 'Filmación y fotografía' : 'Investigación';
  root.innerHTML = `
    ${_resEstado(ts, nombreTipo, region)}
    <div id="res-presion-host"></div>
    <div class="pano-grid">${_resIngresos(ts, desde, hasta)}${_resTiempos(ts)}</div>
    <div class="pano-grid res-grid-b">${_resBandeja(ts)}${_resRegiones(tsTipo, region)}</div>`;
  renderPresion(region, tipo);   // static/js/presion.js (solo con una región elegida)
  if (!root.dataset.listo) {
    _activarInteraccion(root);
    // Clic (o Enter) en una fila de la matriz regional = mismo filtro que los botones
    const elegir = e => {
      const fila = e.target.closest('.res-reg[data-region]');
      if (fila) setRegion(fila.dataset.region);
    };
    root.addEventListener('click', elegir);
    root.addEventListener('keydown', e => { if (e.key === 'Enter') elegir(e); });
    root.dataset.listo = '1';
  }
}

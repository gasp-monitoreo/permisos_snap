/* ═══════════════════════════════════════════════
   Centro de atención del Resumen: lo que requiere acción hoy, antes que el desempeño.
   Tres tarjetas (atraso de CONAF, vence en 7 días, espera del solicitante), una frase
   que resume la situación y un panel lateral con el detalle solo cuando se pide.
   La escala sigue al filtro de región: todo el país → agrupa por región;
   una región → agrupa por área protegida. No muestra nombres de funcionarios.
   Usa de app.js: situacionTramite, escHtml, openModal, setRegion, REGIONES_CHILE.
   Usa de resumen.js: _diasDesde.
   ═══════════════════════════════════════════════ */
'use strict';

const ATN_DIA = 86400000;
const ATN_HORIZONTE = 7;        // días hacia adelante para «vence pronto»
const ATN_ESPERA_LARGA = 30;    // días sin respuesta del solicitante que ameritan recordatorio
const ATN_LISTAS = {
  atraso:      { titulo: 'Atrasadas en CONAF',          sub: 'Plazo vencido con la etapa en manos de CONAF. Ordenadas por días de atraso.' },
  proximos:    { titulo: `Vencen en ${ATN_HORIZONTE} días`, sub: 'Aún al día: actuar ahora evita que pasen a atraso.' },
  solicitante: { titulo: 'Esperando al solicitante',    sub: 'Deben responder, subsanar o cerrar el trámite en Cero Filas. No es atraso de CONAF.' },
};
let _atn = null;   // último cálculo (para abrir el panel sin recalcular)

const _atnPlural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const _atnRegion = nombre => REGIONES_CHILE.find(r => r.nombre === nombre);

// Días desde la fecha de vencimiento ya pasada más antigua (etapa actual o plazo del proceso)
function _atnDiasAtraso(t, hoy) {
  const fechas = [t.etapa_actual?.fecha_vencimiento, t.fecha_limite_proceso]
    .filter(Boolean).map(f => new Date(f)).filter(f => f < hoy);
  return fechas.length ? Math.floor((hoy - Math.min(...fechas)) / ATN_DIA) : 0;
}

// Escala (porArea): false = país (agrupa por región) · 'area' = región (por área) · 'etapa' = área (por etapa)
function _atnGrupos(t, porArea) {
  if (porArea === 'etapa') return [t.etapa_actual?.tarea_nombre || 'Etapa en curso'];
  if (porArea) return t.areas_protegidas?.length ? t.areas_protegidas : ['Sin área indicada'];
  return t.regiones_list?.length ? t.regiones_list : ['Sin región indicada'];
}

// Atrasadas en una fecha dada, reconstruido desde las etapas (para la tendencia semanal)
function _atnAtrasadasEn(ts, fecha) {
  return ts.filter(t => !t.suspendido && (t.etapas || []).some(e => {
    if (!e.fecha_vencimiento || !e.fecha_inicio || (e.email && !/@conaf\.(gob\.)?cl$/i.test(e.email))) return false;
    const ini = new Date(e.fecha_inicio), fin = e.fecha_termino ? new Date(e.fecha_termino) : null;
    return ini <= fecha && (!fin || fin > fecha) && new Date(e.fecha_vencimiento) < fecha;
  })).length;
}

function _atnCalcular(ts, region) {
  const hoy = new Date();
  const L = { atraso: [], proximos: [], solicitante: [] };
  let cierre = 0, suspendidas = 0, largas = 0;
  ts.forEach(t => {
    const sit = situacionTramite(t);
    const ea = t.etapa_actual || {};
    const base = { t, etapa: ea.tarea_nombre || '' };
    if (sit === 'vencido') L.atraso.push({ ...base, dias: _atnDiasAtraso(t, hoy) });
    else if (sit === 'al_dia') {
      const fv = fechaVencimientoEfectiva(t);
      const d = fv ? Math.ceil((new Date(fv) - hoy) / ATN_DIA) : null;
      if (d !== null && d >= 0 && d <= ATN_HORIZONTE) L.proximos.push({ ...base, dias: d });
    } else if (sit === 'espera_solicitante' || sit === 'cierre_solicitante') {
      const desde = sit === 'cierre_solicitante' ? (t.fecha_resolucion || t.fecha_modificacion) : (ea.fecha_inicio || t.fecha_inicio);
      const dias = _diasDesde(desde) ?? 0;
      if (sit === 'cierre_solicitante') cierre++;
      else if (dias > ATN_ESPERA_LARGA) largas++;
      L.solicitante.push({ ...base, dias, cierre: sit === 'cierre_solicitante' });
    } else if (sit === 'suspendido') suspendidas++;
  });
  L.atraso.sort((a, b) => b.dias - a.dias);
  L.proximos.sort((a, b) => a.dias - b.dias);
  L.solicitante.sort((a, b) => a.cierre - b.cierre || b.dias - a.dias);
  const semana = new Date(hoy - 7 * ATN_DIA);
  const delta = _atnAtrasadasEn(ts, hoy) - _atnAtrasadasEn(ts, semana);
  const dup = ts.filter(t => STATE.duplicados?.has(t.id));
  return { L, cierre, suspendidas, largas, delta, region, dup, porArea: STATE.area ? 'etapa' : region ? 'area' : false };
}

function _atnTop(items, porArea, n = 3) {
  const m = new Map();
  items.forEach(i => _atnGrupos(i.t, porArea).forEach(g => {
    const x = m.get(g) || { g, n: 0, max: 0 };
    x.n++; x.max = Math.max(x.max, i.dias || 0);
    m.set(g, x);
  }));
  return [...m.values()].sort((a, b) => b.n - a.n || b.max - a.max).slice(0, n);
}

function _atnFrase(a) {
  const { L, region, porArea, delta, largas } = a;
  const donde = (STATE.area ? `En ${escHtml(STATE.area)}` : region ? `En ${escHtml(region)}` : 'En todo el país') + (STATE.mio ? ' (a su cargo)' : '');
  const partes = [];
  const n = L.atraso.length;
  if (n) {
    const tend = delta > 0 ? `, ${delta} más que hace una semana` : delta < 0 ? `, ${-delta} menos que hace una semana` : '';
    partes.push(`${donde} hay <strong>${_atnPlural(n, 'solicitud atrasada', 'solicitudes atrasadas')} en CONAF</strong>${tend}.`);
    const top = _atnTop(L.atraso, porArea, 2);
    if (n >= 3 && top.length) {
      const suma = top.reduce((s, x) => s + x.n, 0);
      if (top.length === 2 && suma >= n / 2) partes.push(`${escHtml(top[0].g)} y ${escHtml(top[1].g)} concentran ${suma}.`);
      else if (top[0].n >= n / 2) partes.push(`${escHtml(top[0].g)} concentra ${top[0].n}.`);
    }
  } else {
    partes.push(`${donde} <strong>no hay solicitudes atrasadas en CONAF</strong>.`);
  }
  if (L.proximos.length) partes.push(`${n ? 'Otras' : 'Hay'} ${_atnPlural(L.proximos.length, 'vence', 'vencen')} en los próximos ${ATN_HORIZONTE} días.`);
  const esperan = L.solicitante.length - a.cierre;
  if (esperan) partes.push(`${_atnPlural(esperan, 'espera', 'esperan')} respuesta del solicitante${largas ? ` (${largas} hace más de ${ATN_ESPERA_LARGA} días)` : ''}.`);
  return partes.join(' ');
}

const _ATN_ICONOS = {
  atraso: '<path d="M12 3 2 20h20zM12 10v4M12 17.5v.01"/>',
  proximos: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  solicitante: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20a6.5 6.5 0 0 1 13 0M18 9v6M21 9v6"/>',
};

function _atnTarjeta(clave, clase, cifra, extra, cuerpo, boton) {
  return `<article class="atn-card atn-card--${clase}">
    <header><svg viewBox="0 0 24 24" aria-hidden="true">${_ATN_ICONOS[clave]}</svg><h3>${ATN_LISTAS[clave].titulo}</h3></header>
    <div class="atn-cifra"><strong>${cifra}</strong>${extra}</div>
    <div class="atn-cuerpo">${cuerpo}</div>
    ${boton ? `<button class="atn-ver" data-atn-lista="${clave}">${boton} <span aria-hidden="true">→</span></button>
      <button class="atn-tabla" data-atn-tabla="${clave}">Trabajar en la tabla de permisos ↓</button>` : ''}
  </article>`;
}

function _atnTopHtml(items, clave, porArea) {
  return `<ul class="atn-top">${_atnTop(items, porArea).map(x => {
    const cod = !porArea ? _atnRegion(x.g)?.codigo : '';
    return `<li><button data-atn-lista="${clave}" data-atn-grupo="${escHtml(x.g)}" title="${porArea === 'etapa' ? 'Ver estas solicitudes' : porArea ? 'Acercarse a esta área protegida' : 'Acercarse a esta región'}">
      <span>${cod ? `<span class="reg-cod">${cod}</span> ` : ''}${escHtml(x.g)}</span>
      <em>${x.n} · ${clave === 'atraso' ? 'máx.' : 'hasta'} ${x.max} d</em></button></li>`;
  }).join('')}</ul>`;
}

function renderAtencion(ts, region) {
  const root = document.getElementById('atencion');
  if (!root) return;
  const a = _atn = _atnCalcular(ts, region);
  const { L, porArea } = a;

  const nA = L.atraso.length;
  const delta = a.delta > 0 ? `<span class="atn-delta sube" title="Estimado desde las fechas de las etapas">↑ ${a.delta} vs. hace 7 días</span>`
    : a.delta < 0 ? `<span class="atn-delta baja" title="Estimado desde las fechas de las etapas">↓ ${-a.delta} vs. hace 7 días</span>`
    : '<span class="atn-delta">igual que hace 7 días</span>';
  const t1 = _atnTarjeta('atraso', 'rojo', nA, nA ? delta : '',
    nA ? _atnTopHtml(L.atraso, 'atraso', porArea) : '<p class="atn-ok">Todo al día. Buen trabajo.</p>',
    nA ? `Revisar ${nA === 1 ? 'la solicitud' : `las ${nA}`}` : '');

  const dias = Array.from({ length: ATN_HORIZONTE + 1 }, (_, d) => L.proximos.filter(i => i.dias === d).length);
  const max = Math.max(...dias, 1);
  const etiquetaDia = d => d === 0 ? 'hoy' : d === 1 ? 'mañana' : `en ${d} días`;
  const cal = `<div class="atn-cal" role="img" aria-label="Vencimientos por día">${dias.map((v, d) =>
    `<span class="${v ? 'con' : ''}" style="height:${v ? Math.max(18, v / max * 100) : 6}%" title="${v} ${etiquetaDia(d)}"></span>`).join('')}</div>
    <div class="atn-cal-eje"><span>hoy</span><span>+${ATN_HORIZONTE} d</span></div>`;
  const nP = L.proximos.length;
  const t2 = _atnTarjeta('proximos', 'ambar', nP,
    nP ? `<span class="atn-delta">la primera vence ${etiquetaDia(L.proximos[0].dias)}</span>` : '',
    nP ? cal : '<p class="atn-ok">Nada vence esta semana.</p>', nP ? 'Planificar' : '');

  const esperan = L.solicitante.length - a.cierre;
  const lineas = [
    esperan ? `<li><strong>${esperan}</strong> deben responder o subsanar${a.largas ? ` · <span class="atn-largas">${a.largas} hace más de ${ATN_ESPERA_LARGA} d</span>` : ''}</li>` : '',
    a.cierre ? `<li><strong>${a.cierre}</strong> resueltas, falta que cierren en Cero Filas</li>` : '',
    a.suspendidas ? `<li class="atn-susp"><strong>${a.suspendidas}</strong> en suspensión</li>` : '',
  ].join('');
  const t3 = _atnTarjeta('solicitante', 'azul', L.solicitante.length,
    '<span class="atn-delta">no es atraso de CONAF</span>',
    lineas ? `<ul class="atn-lineas">${lineas}</ul>` : '<p class="atn-ok">Ninguna espera al solicitante.</p>',
    L.solicitante.length ? (a.largas ? 'Ver a quién recordar' : 'Ver solicitudes') : '');

  const fijo = window.PERFIL?.solo_su_region && !window.PERFIL?.superusuario;
  const ambito = region
    ? `<span class="atn-ambito">${_atnRegion(region)?.codigo ? `<span class="reg-cod">${_atnRegion(region).codigo}</span> ` : ''}${escHtml(region)}${fijo || STATE.area ? '' : ' <button data-atn-pais title="Volver a todo el país" aria-label="Volver a todo el país">✕</button>'}
        ${STATE.area ? `<span class="atn-sep">›</span>${escHtml(STATE.area)} <button data-atn-region title="Volver a toda la región" aria-label="Volver a toda la región">✕</button>` : ''}</span>`
    : '<span class="atn-ambito">Todo el país</span>';
  const dupGrupos = a.dup.length;
  const avisoDup = dupGrupos ? `<button class="atn-dup" data-atn-dup>⚠ ${_atnPlural(dupGrupos, 'permiso podría ser un duplicado regional', 'permisos podrían ser duplicados regionales')}
    (mismo titular y proyecto en otra región): conviene consolidarlos. <b>Revisar →</b></button>` : '';
  const fecha = new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });

  root.innerHTML = `
    <div class="atn-head">
      <div><span class="atn-eyebrow">Requiere atención · ${fecha}</span>${ambito}</div>
      <span class="atn-escala">${porArea === 'etapa' ? 'Agrupado por etapa en curso' : porArea ? 'Agrupado por área protegida · clic en un área para acercarse' : 'Agrupado por región · clic en una región para acercarse'}</span>
    </div>
    <p class="atn-frase">${_atnFrase(a)}</p>
    <div class="atn-cards">${t1}${t2}${t3}</div>
    ${avisoDup}`;

  if (!root.dataset.listo) {
    root.addEventListener('click', e => {
      if (e.target.closest('[data-atn-pais]')) { setAmbito(null); return; }
      if (e.target.closest('[data-atn-region]')) { setArea(null); return; }
      if (e.target.closest('[data-atn-dup]')) { _atnAbrirDuplicados(); return; }
      const tabla = e.target.closest('[data-atn-tabla]');
      if (tabla) { window.filtrarTablaPermisos?.(tabla.dataset.atnTabla); return; }
      const b = e.target.closest('[data-atn-lista]');
      if (!b) return;
      const grupo = b.dataset.atnGrupo;
      const subir = () => document.getElementById('filtro-regiones')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (grupo && !_atn.porArea && _atnRegion(grupo) && !window.PERFIL?.solo_su_region) { setAmbito(grupo); subir(); return; }   // país → región
      if (grupo && _atn.porArea === 'area' && grupo !== 'Sin área indicada') { setArea(grupo); subir(); return; }                // región → área
      _atnAbrirPanel(b.dataset.atnLista, grupo);
    });
    root.dataset.listo = '1';
  }
}

// ─── Panel lateral con el detalle (a pedido) ──────────────────────────────────
function _atnAbrirPanel(clave, grupo) {
  const panel = document.getElementById('atn-panel');
  if (!panel || !_atn) return;
  let items = _atn.L[clave];
  if (grupo) items = items.filter(i => _atnGrupos(i.t, _atn.porArea).includes(grupo));
  const etiqueta = i => clave === 'atraso' ? `${i.dias} d de atraso`
    : clave === 'proximos' ? (i.dias === 0 ? 'vence hoy' : `vence en ${i.dias} d`)
    : i.cierre ? `falta cierre · ${i.dias} d` : `espera ${i.dias} d`;
  const clase = i => clave === 'atraso' || (clave === 'proximos' && i.dias <= 1) || (!i.cierre && i.dias > ATN_ESPERA_LARGA) ? 'fuerte' : '';
  document.getElementById('atn-panel-tit').textContent = ATN_LISTAS[clave].titulo + (grupo ? ` · ${grupo}` : '');
  document.getElementById('atn-panel-sub').textContent = `${_atnPlural(items.length, 'solicitud', 'solicitudes')}. ${ATN_LISTAS[clave].sub}`;
  document.getElementById('atn-panel-lista').innerHTML = items.map(i => {
    const t = i.t;
    const donde = (t.areas_protegidas?.length ? t.areas_protegidas : t.regiones_list || []).join(', ');
    return `<button class="atn-fila" data-id="${t.id}">
      <span class="atn-fila-txt">
        <strong>#${t.id} · ${escHtml(t.nombre_solicitante || 'Sin nombre')}</strong>
        <small>${escHtml(donde || 'Sin ubicación')}${i.etapa ? ` · ${escHtml(i.etapa)}` : ''}</small>
      </span>
      <span class="atn-fila-dias ${clase(i)}">${etiqueta(i)}</span>
    </button>`;
  }).join('') || '<div class="empty-msg">Sin solicitudes</div>';
  panel.hidden = false;
  document.getElementById('atn-velo').hidden = false;
  requestAnimationFrame(() => panel.classList.add('abierto'));
  panel.querySelector('.atn-cerrar').focus();
}

function _atnAbrirDuplicados() {
  const panel = document.getElementById('atn-panel');
  if (!panel || !_atn) return;
  document.getElementById('atn-panel-tit').textContent = 'Posibles duplicados regionales';
  document.getElementById('atn-panel-sub').textContent = 'El mismo titular pidió el mismo proyecto en distintas regiones. Corresponde consolidarlos en una sola solicitud.';
  document.getElementById('atn-panel-lista').innerHTML = _atn.dup.map(t => {
    const otros = STATE.duplicados.get(t.id) || [];
    return `<button class="atn-fila" data-id="${t.id}"><span class="atn-fila-txt">
      <strong>#${t.id} · ${escHtml(t.nombre_solicitante || '')}</strong>
      <small>${escHtml((t.regiones_list || []).join(', '))} · también: ${otros.map(o => `#${o.id} (${escHtml((o.regiones_list || []).join(', '))})`).join(', ')}</small>
    </span><span class="atn-fila-dias">${otros.length + 1} solicitudes</span></button>`;
  }).join('');
  panel.hidden = false;
  document.getElementById('atn-velo').hidden = false;
  requestAnimationFrame(() => panel.classList.add('abierto'));
}

function _atnCerrarPanel() {
  const panel = document.getElementById('atn-panel');
  if (!panel || panel.hidden) return;
  panel.classList.remove('abierto');
  document.getElementById('atn-velo').hidden = true;
  setTimeout(() => { panel.hidden = true; }, 200);
}

document.addEventListener('DOMContentLoaded', () => {
  const panel = document.getElementById('atn-panel');
  if (!panel) return;
  panel.addEventListener('click', e => {
    if (e.target.closest('.atn-cerrar')) return _atnCerrarPanel();
    const fila = e.target.closest('.atn-fila');
    if (fila) openModal(Number(fila.dataset.id));
  });
  document.getElementById('atn-velo').addEventListener('click', _atnCerrarPanel);
  document.addEventListener('keydown', e => {
    // Con el detalle de un trámite abierto (modal), Escape no cierra el panel de atrás
    const modalAbierto = [...document.querySelectorAll('.modal-overlay')].some(m => m.style.display === 'flex');
    if (e.key === 'Escape' && !modalAbierto) _atnCerrarPanel();
  });

  // «Desempeño del período» recuerda si quedó abierto
  const des = document.getElementById('desempeno');
  if (des) {
    try { des.open = localStorage.getItem('desempeno-abierto') !== '0'; } catch (e) { des.open = true; }   // abierto por defecto
    des.addEventListener('toggle', () => { try { localStorage.setItem('desempeno-abierto', des.open ? '1' : '0'); } catch (e) {} });
  }
});

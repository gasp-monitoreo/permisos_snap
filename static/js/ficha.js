/* ═══════════════════════════════════════════════
   Ficha del trámite (modal de detalle), en tres capas de lectura:
     1. Encabezado: qué permiso es, su estado y las acciones.
     2. «Situación ahora» y la línea de tiempo del permiso (estilo LifeLines,
        Plaisant et al. 1996): trámite, etapas con su plazo y quién las tiene,
        resolución, período en terreno y hoy, en un solo eje.
     3. Pestañas con todo el detalle: resumen del proyecto, solicitud completa,
        territorio y registro del titular, seguimiento de CONAF, documentos,
        cumplimiento y permisos relacionados.
   app.js (renderModalBody) arma las piezas del formulario y llama a Ficha.html / Ficha.activar.
   Usa de app.js: escHtml, safeUrl, badgeHtml, tipoBadgeHtml, tipoTramite, nombreProceso,
   formatDate, situacionTramite, humanizarValorCampo, adjuntoNombreDesdeKey, adjuntoExtension,
   openModal, STATE. De resumen.js: RES_ESTADOS, _regionesDeResponsables.
   ═══════════════════════════════════════════════ */
'use strict';
window.Ficha = (() => {
  const DIA = 86400000;
  const RESOLUCION = /^(autorizacion|autorizacion_firmada|resolucion|resolucion_aprobacion|documento_aprobacion)$/i;
  const esConaf = email => /@conaf\.(gob\.)?cl$/i.test((email || '').trim());
  const f = iso => iso ? formatDate(iso) : '–';
  const dias = (a, b) => Math.round((b - a) / DIA);
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

  // Fechas del formulario: dd-mm-aaaa, aaaa-mm-dd o dd/mm/aaaa
  function fecha(v) {
    const s = String(v || '').trim().slice(0, 10);
    let m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], 12);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : null;
  }

  // Primer campo del formulario cuyo nombre calza con alguno de los patrones
  function campo(datos, ...patrones) {
    for (const p of patrones) {
      const k = Object.keys(datos).find(k => p.test(k) && datos[k] != null && String(datos[k]).trim() !== '' && typeof datos[k] !== 'object');
      if (k) return humanizarValorCampo(datos[k]) ?? String(datos[k]);
    }
    return '';
  }

  function periodo(t) {
    const d = t.datos_raw || {};
    let ini = fecha(d.fecha_inicio_actividades), fin = fecha(d.fecha_termino_actividades);
    if (!ini) {   // filmación: fechas por región
      const inis = Object.keys(d).filter(k => /^fecha_inicio_/.test(k)).map(k => fecha(d[k])).filter(Boolean);
      const fins = Object.keys(d).filter(k => /^fecha_termino_/.test(k)).map(k => fecha(d[k])).filter(Boolean);
      ini = inis.length ? new Date(Math.min(...inis)) : null;
      fin = fins.length ? new Date(Math.max(...fins)) : null;
    }
    return { ini, fin };
  }

  function etapas(t) {
    const regionDe = typeof _regionesDeResponsables === 'function' ? _regionesDeResponsables() : new Map();
    return [...(t.etapas || [])].sort((a, b) => (a.id || 0) - (b.id || 0)).map((e, i) => {
      const ini = e.fecha_inicio ? new Date(e.fecha_inicio) : null;
      const fin = e.fecha_termino ? new Date(e.fecha_termino) : (e.estado === 'pendiente' ? new Date() : null);
      const vence = e.fecha_vencimiento ? new Date(e.fecha_vencimiento) : null;
      const conaf = !e.email || esConaf(e.email);
      const clave = (e.email || e.nombres || '').toLowerCase();
      return {
        e, n: i + 1, nombre: e.tarea_nombre || `Etapa ${i + 1}`, ini, fin, vence, conaf,
        oficina: conaf ? (regionDe.get(clave) || (clave ? 'Nivel central / varias regiones' : 'Sin responsable')) : 'Titular del permiso',
        usados: ini && fin ? dias(ini, fin) : null,
        plazo: ini && vence ? dias(ini, vence) : null,
        atraso: vence && fin && fin > vence ? dias(vence, fin) : 0,
      };
    });
  }

  // ─── Situación ahora ───────────────────────────────────────────────────────
  function situacion(t, et, piezas) {
    const sit = situacionTramite(t);
    const color = (RES_ESTADOS.find(e => e.key === sit) || {}).color || '#888';
    const actual = et.find(x => x.e.estado === 'pendiente');
    const hoy = new Date();
    let titulo = '', detalle = '';
    if (sit === 'vencido' && actual) {
      titulo = `Atraso de CONAF: «${escHtml(actual.nombre)}» venció hace ${plural(dias(actual.vence, hoy), 'día', 'días')}`;
      detalle = `A cargo de ${escHtml(actual.e.nombres || 'sin asignar')} (${escHtml(actual.oficina)}) desde el ${f(actual.e.fecha_inicio)}.`;
    } else if (sit === 'al_dia' && actual) {
      titulo = `En evaluación en CONAF: «${escHtml(actual.nombre)}»`;
      detalle = `Desde el ${f(actual.e.fecha_inicio)} (${plural(dias(actual.ini, hoy), 'día', 'días')}) · a cargo de ${escHtml(actual.e.nombres || 'sin asignar')} (${escHtml(actual.oficina)})${actual.vence ? ` · vence el ${f(actual.e.fecha_vencimiento)} (en ${plural(Math.max(0, dias(hoy, actual.vence)), 'día', 'días')})` : ''}.`;
    } else if (sit === 'espera_solicitante') {
      titulo = 'Esperando al titular: debe responder o subsanar en Cero Filas';
      detalle = actual ? `Desde el ${f(actual.e.fecha_inicio)} (${plural(dias(actual.ini, hoy), 'día', 'días')}). No es atraso de CONAF.` : '';
    } else if (sit === 'suspendido') {
      titulo = 'Trámite en suspensión';
    } else {
      const res = t.fecha_resolucion || t.fecha_termino;
      const tomo = res && t.fecha_inicio ? dias(new Date(t.fecha_inicio), new Date(res)) : null;
      titulo = sit === 'rechazado' ? 'Rechazado por CONAF' : 'Aprobado por CONAF';
      detalle = `${res ? `Resuelto el ${f(res)}` : ''}${tomo !== null ? `, ${plural(tomo, 'día', 'días')} después del ingreso` : ''}.`;
      const pend = [];
      if (sit === 'cierre_solicitante') pend.push('el titular debe cerrar el trámite en Cero Filas');
      if (sit !== 'rechazado' && IDS_INVESTIGACION.has(t.proceso_id) && !piezas.entregaOk) pend.push('entregar resultados (Numeral 6)');
      if (pend.length) detalle += ` Pendiente: ${pend.join(' · ')}.`;
      if (sit !== 'rechazado') detalle += '<span id="fx-pend-registro"></span>';   // se completa al consultar el registro geográfico
    }
    return `<section class="fx-ahora" style="--c:${color}">
      <span class="fx-eyebrow">Situación ahora</span>
      <strong>${titulo}</strong>${detalle ? `<p>${detalle}</p>` : ''}
      ${t.estado === 'pendiente' ? `<div class="fx-avance" title="${t.etapas_completadas} de ${t.total_etapas} etapas"><i style="width:${Math.min(100, t.porcentaje_avance || 0)}%"></i></div>` : ''}
    </section>`;
  }

  // ─── Línea de tiempo (SVG) ─────────────────────────────────────────────────
  // Escala: por defecto el AÑO CALENDARIO del ingreso (ene–dic), igual para todos los permisos,
  // así se comparan entre sí. Se puede ampliar a «ajustar al permiso» o «hasta los resultados».
  const ESCALAS = { anio: 'Año calendario', permiso: 'Ajustar al permiso', todo: 'Hasta la entrega de resultados' };

  function plazoResultados(t) {
    // Numeral 6: los resultados se entregan dentro de 3 años desde el término del trámite
    const base = t.fecha_termino || t.fecha_resolucion;   // si el titular no ha cerrado, desde la resolución
    const fin = base ? new Date(base) : null;
    return fin ? new Date(fin.getFullYear() + 3, fin.getMonth(), fin.getDate(), 12) : null;
  }

  function lineaDeTiempo(t, et, escala = 'anio') {
    const hoy = new Date();
    const ingreso = t.fecha_inicio ? new Date(t.fecha_inicio) : null;
    if (!ingreso) return '';
    const res = t.estado !== 'pendiente' && (t.fecha_resolucion || t.fecha_termino) ? new Date(t.fecha_resolucion || t.fecha_termino) : null;
    const { ini: aIni, fin: aFin } = periodo(t);
    const plazoN6 = IDS_INVESTIGACION.has(t.proceso_id) ? plazoResultados(t) : null;
    let min, max;
    if (escala === 'anio') {
      min = +new Date(ingreso.getFullYear(), 0, 1); max = +new Date(ingreso.getFullYear(), 11, 31, 23, 59);
    } else {
      const pts = [ingreso, res, aIni, aFin, hoy, ...et.flatMap(x => [x.ini, x.fin, x.vence]), ...(escala === 'todo' ? [plazoN6] : [])].filter(Boolean).map(Number);
      min = Math.min(...pts); max = Math.max(...pts);
      const margen = Math.max((max - min) * 0.03, 2 * DIA);
      min -= margen; max += margen;
    }
    const span = max - min;
    const W = 1000, IZQ = 128, DER = 16, ancho = W - IZQ - DER;
    const dentro = d => d && +d >= min && +d <= max;
    const xn = d => IZQ + (Math.min(max, Math.max(min, +d)) - min) / span * ancho;
    const x = d => xn(d).toFixed(1);
    const filas = [];
    let y = 30;
    const carril = (titulo, contenido, alto = 20) => {
      filas.push(`<text x="0" y="${y + alto / 2 + 4}" class="fx-tl-lbl">${escHtml(titulo)}</text>${contenido(y, alto)}`);
      y += alto + 12;
    };
    // flecha cuando una barra sigue fuera de la escala elegida
    const sigue = (a, b, yy, h) => (+a < min ? `<text x="${IZQ - 2}" y="${yy + h / 2 + 4}" class="fx-tl-sigue" text-anchor="end">‹</text>` : '')
      + (+b > max ? `<text x="${W - DER + 10}" y="${yy + h / 2 + 4}" class="fx-tl-sigue">›</text>` : '');
    et.forEach(s => {
      if (!s.ini) return;
      carril(s.nombre.length > 18 ? s.nombre.slice(0, 17) + '…' : s.nombre, (yy, h) => {
        const fin = s.fin || hoy;
        if (+fin < min || +s.ini > max) return '';
        const color = s.conaf ? '#347A17' : '#3F7CB8';
        const tip = `${s.nombre} · a cargo de ${s.conaf ? 'CONAF' : 'el titular'} · ${f(s.e.fecha_inicio)} → ${s.e.fecha_termino ? f(s.e.fecha_termino) : 'en curso'} (${s.usados ?? 0} días)${s.vence ? ` · plazo ${f(s.e.fecha_vencimiento)}` : ''}${s.atraso ? ` · ${s.atraso} días fuera de plazo` : ''}`;
        let svg = `<rect x="${x(s.ini)}" y="${yy}" width="${Math.max(3, xn(fin) - xn(s.ini)).toFixed(1)}" height="${h}" rx="4" fill="${color}" opacity="${s.e.estado === 'pendiente' ? .75 : 1}"><title>${escHtml(tip)}</title></rect>`;
        if (s.atraso && s.vence && dentro(s.vence) || (s.atraso && +s.vence < min)) svg += `<rect x="${x(s.vence)}" y="${yy}" width="${Math.max(2, xn(fin) - xn(s.vence)).toFixed(1)}" height="${h}" rx="4" fill="#B9412F"><title>${escHtml(`${s.atraso} días después del plazo`)}</title></rect>`;
        if (dentro(s.vence)) svg += `<line x1="${x(s.vence)}" x2="${x(s.vence)}" y1="${yy - 4}" y2="${yy + h + 4}" stroke="#B9412F" stroke-width="2" stroke-dasharray="3 2"><title>Plazo de la etapa: ${escHtml(f(s.e.fecha_vencimiento))}</title></line>`;
        return svg + sigue(s.ini, fin, yy, h);
      });
    });
    if (aIni) carril('En terreno', (yy, h) => (+(aFin || aIni) < min || +aIni > max) ? `<text x="${IZQ + 4}" y="${yy + h / 2 + 4}" class="fx-tl-tick">fuera de esta escala (${escHtml(aIni.toLocaleDateString('es-CL'))})</text>`
      : `<rect x="${x(aIni)}" y="${yy}" width="${Math.max(3, xn(aFin || aIni) - xn(aIni)).toFixed(1)}" height="${h}" rx="4" fill="#D9A13B"><title>Actividades en terreno declaradas: ${escHtml(aIni.toLocaleDateString('es-CL'))} → ${escHtml((aFin || aIni).toLocaleDateString('es-CL'))}</title></rect>${sigue(aIni, aFin || aIni, yy, h)}`);
    const hitos = [[ingreso, 'Ingreso', '#013722'], [res, t.estado === 'rechazado' ? 'Rechazo' : 'Resolución', t.estado === 'rechazado' ? '#6B4A8C' : '#347A17'],
      [plazoN6, 'Plazo resultados', '#0155A0']]
      .filter(h => dentro(h[0])).sort((p, q) => p[0] - q[0]);
    // etiquetas que quedarían encimadas: la anterior se alinea a la izquierda y la siguiente a la derecha
    const anclas = hitos.map(() => 'middle');
    hitos.forEach((h, i) => { if (i && xn(h[0]) - xn(hitos[i - 1][0]) < 80) { anclas[i - 1] = 'end'; anclas[i] = 'start'; } });
    const hitosSvg = hitos.map(([d, n, c], i) => `<g><circle cx="${x(d)}" cy="16" r="6" fill="${c}"/><text x="${x(d)}" y="6" dx="${anclas[i] === 'end' ? -4 : anclas[i] === 'start' ? 4 : 0}" class="fx-tl-hito" text-anchor="${anclas[i]}">${n}</text><title>${n}: ${escHtml(d.toLocaleDateString('es-CL'))}</title></g>`).join('');
    const alto = y + 22;
    const ticks = [];
    const anual = span > 500 * DIA;
    const t0 = new Date(min); t0.setDate(1); t0.setHours(0, 0, 0, 0); if (anual) t0.setMonth(0);
    for (let d = new Date(t0); +d <= max; anual ? d.setFullYear(d.getFullYear() + 1) : d.setMonth(d.getMonth() + 1)) {
      if (+d < min) continue;
      const etiqueta = anual ? d.getFullYear() : d.toLocaleDateString('es-CL', { month: 'short' }).replace('.', '') + (d.getMonth() === 0 || escala !== 'anio' && +d === +t0 ? ` ${String(d.getFullYear()).slice(2)}` : '');
      ticks.push(`<line x1="${x(d)}" x2="${x(d)}" y1="24" y2="${alto - 18}" class="fx-tl-grid"/><text x="${x(d)}" y="${alto - 4}" class="fx-tl-tick" text-anchor="${anual ? 'middle' : 'start'}" dx="${anual ? 0 : 3}">${etiqueta}</text>`);
    }
    return `<section class="fx-tl" aria-label="Línea de tiempo del permiso">
      <div class="fx-tl-cab"><strong>Línea de tiempo${escala === 'anio' ? ` · ${ingreso.getFullYear()}` : ''}</strong>
        <div class="fx-tl-escalas" role="group" aria-label="Escala">${Object.entries(ESCALAS).map(([k, v]) =>
          `<button data-fx-escala="${k}" aria-pressed="${k === escala}">${v}</button>`).join('')}</div></div>
      <svg viewBox="0 0 ${W} ${alto}" role="img" preserveAspectRatio="none" style="height:${alto}px">
        ${ticks.join('')}${filas.join('')}${hitosSvg}
        ${dentro(hoy) ? `<line x1="${x(hoy)}" x2="${x(hoy)}" y1="20" y2="${alto - 16}" class="fx-tl-hoy"/><text x="${x(hoy)}" y="${alto - 4}" class="fx-tl-hoytxt" text-anchor="middle">hoy</text>` : ''}
      </svg>
      <div class="fx-tl-ley"><span><i style="background:#347A17"></i>Etapa en manos de CONAF</span><span><i style="background:#3F7CB8"></i>Etapa en manos del titular</span>
        <span><i style="background:#B9412F"></i>Tiempo fuera del plazo de la etapa</span><span><i class="fx-tl-ley-linea"></i>Plazo de la etapa</span><span><i style="background:#D9A13B"></i>Actividades en terreno</span></div>
      <details class="fx-tl-ayuda"><summary>¿Cómo leer esta línea de tiempo?</summary>
        <p>Cada fila es una <b>etapa del trámite en Cero Filas</b>: la barra va desde que la etapa se abrió hasta que se completó (o hasta hoy, si sigue abierta).
          El color indica <b>quién debía actuar</b>: verde, un funcionario de CONAF (evaluación, visación, firma); azul, el titular (enviar la solicitud, subsanar, cerrar el trámite).</p>
        <p>Las barras tienen <b>largos distintos</b> porque cada etapa dura lo que tardó su responsable: una revisión puede resolverse en un día y una subsanación del titular demorar semanas.
          La línea roja punteada es el <b>plazo</b> que tenía esa etapa; lo que pasa de ella se pinta en rojo. «En terreno» es el período de actividades que el titular declaró en la solicitud.</p>
        <p>La escala por defecto es el <b>año calendario</b> del ingreso, igual para todos los permisos, para compararlos entre sí. «Ajustar al permiso» amplía para ver el detalle;
          «Hasta la entrega de resultados» muestra además el plazo del Numeral 6 (3 años desde el término del trámite). Las flechas ‹ › indican que una barra continúa fuera de la escala.</p>
      </details>
    </section>`;
  }

  // ─── Pestañas ──────────────────────────────────────────────────────────────
  function resumen(t, piezas) {
    const d = t.datos_raw || {};
    const tarjetas = [
      ['Objetivo', campo(d, /^objetivo_general$/, /^objetivos?_del_proyecto$/, /^objetivos?$/, /^descripcion(_proyecto)?$/, /objetivo/)],
      ['Metodología y actividades', campo(d, /metodolog/, /^breve_descripcion_actividades/, /^actividades(_a_realizar)?$/, /descripcion_actividades/)],
      ['Especies o grupos de estudio', campo(d, /^especies?$/, /nombre_cientifico/, /nombre_comun/, /especie/)],
      ['Colecta o toma de muestras', campo(d, /colect/, /muestra/, /captura/)],
      ['Equipo', campo(d, /investigadores_asociados/, /^equipo/, /integrantes/)],
      ['Institución', campo(d, /institucion_patrocinante/, /^institucion/, /universidad/, /nombre_empresa/, /razon_social/)],
      ['Financiamiento', campo(d, /financiamiento/, /fondo/, /fondecyt/)],
      ['Ubicación declarada', campo(d, /localizacion_geografica/, /^ubicacion/, /coordenad/)],
    ].filter(([, v]) => v);
    const { ini, fin } = periodo(t);
    return `<div class="fx-resumen">
      ${piezas.banners}
      ${tarjetas.length ? `<div class="fx-tarjetas">${tarjetas.map(([k, v]) => `<article class="fx-tarjeta${v.length > 260 ? ' fx-larga' : ''}"><h4>${k}</h4><p>${escHtml(v)}</p></article>`).join('')}</div>`
        : '<p class="fx-nota">El formulario no trae objetivo, metodología ni especies. Revise «Solicitud completa».</p>'}
      <div class="fx-mini">
        <div><span>Período en terreno</span><strong>${ini ? `${ini.toLocaleDateString('es-CL')} → ${(fin || ini).toLocaleDateString('es-CL')}` : '–'}</strong></div>
        <div><span>Áreas protegidas</span><strong>${escHtml((t.areas_protegidas || []).join(', ') || '–')}</strong></div>
        <div><span>Regiones</span><strong>${escHtml((t.regiones_list || []).join(', ') || '–')}</strong></div>
        <div><span>Proceso</span><strong>${escHtml(nombreProceso(t.proceso_id))}</strong></div>
      </div>
    </div>`;
  }

  function seguimiento(t, et) {
    if (!et.length) return '<p class="fx-nota">Sin etapas registradas en Cero Filas.</p>';
    return `<ol class="fx-etapas">${et.map(s => {
      const estado = s.e.estado === 'completado' ? 'hecha' : s.e.estado === 'pendiente' ? 'actual' : 'otra';
      const uso = s.usados !== null && s.plazo ? Math.min(100, s.usados / s.plazo * 100) : null;
      return `<li class="fx-etapa fx-etapa--${estado}${s.atraso ? ' fx-etapa--atraso' : ''}">
        <div class="fx-etapa-cab"><strong>${s.n}. ${escHtml(s.nombre)}</strong>${badgeHtml(s.e.estado)}${s.atraso ? `<span class="fx-atraso">${s.atraso} d fuera de plazo</span>` : ''}</div>
        <div class="fx-etapa-quien">${s.conaf ? '🏛' : '👤'} ${escHtml(s.e.nombres || 'Sin asignar')}${s.e.email ? ` · ${escHtml(s.e.email)}` : ''} · <em>${escHtml(s.oficina)}</em></div>
        <div class="fx-etapa-fechas"><span>Inicio <b>${f(s.e.fecha_inicio)}</b></span><span>Término <b>${s.e.fecha_termino ? f(s.e.fecha_termino) : 'en curso'}</b></span><span>Plazo <b>${s.e.fecha_vencimiento ? f(s.e.fecha_vencimiento) : '–'}</b></span>
          ${s.usados !== null ? `<span>Días usados <b>${s.usados}${s.plazo ? ` de ${s.plazo}` : ''}</b></span>` : ''}</div>
        ${uso !== null ? `<div class="fx-uso"><i style="width:${uso}%;background:${s.atraso ? '#B9412F' : uso > 80 ? '#D9A13B' : '#347A17'}"></i></div>` : ''}
      </li>`;
    }).join('')}</ol>
    ${t.estado === 'rechazado' && t.motivo_rechazo ? `<div class="fx-motivo"><h4>Motivo del rechazo (registrado por CONAF)</h4><p>${escHtml(t.motivo_rechazo)}</p></div>` : ''}
    <p class="fx-nota">Ingreso ${f(t.fecha_inicio)} · última modificación ${f(t.fecha_modificacion)}${t.fecha_resolucion ? ` · resolución ${f(t.fecha_resolucion)}` : ''}. La oficina se infiere de la región que atiende cada funcionario.</p>`;
  }

  function documentos(t, piezas) {
    const adj = piezas.adjuntos;
    const res = adj.find(([k]) => RESOLUCION.test(k));
    const url = k => `/api/tramites/${t.id}/adjuntos/${encodeURIComponent(k)}`;
    const tarjetas = adj.map(([k, v]) => {
      const { nombre, icono } = adjuntoNombreDesdeKey(k);
      const ext = adjuntoExtension(v);
      return `<a class="fx-doc${RESOLUCION.test(k) ? ' fx-doc--res' : ''}" href="${url(k)}" target="_blank" rel="noopener">
        <span class="fx-doc-ico">${icono}</span><span class="fx-doc-nom">${escHtml(RESOLUCION.test(k) ? 'Resolución / autorización de CONAF' : nombre)}</span><span class="badge-ext">${escHtml(ext)}</span></a>`;
    }).join('');
    return `${res && adjuntoExtension(res[1]) === 'PDF' ? `<div class="fx-visor"><div class="fx-visor-cab"><strong>Resolución / autorización</strong>
        <a href="${url(res[0])}" target="_blank" rel="noopener">Abrir en otra pestaña ↗</a></div>
        <iframe src="${url(res[0])}#view=FitH" title="Resolución del trámite ${t.id}" loading="lazy"></iframe></div>` : ''}
      ${adj.length ? `<div class="fx-docs-cab"><h4>Documentos del trámite <small>${adj.length}</small></h4>
        <a class="fx-btn" href="/api/tramites/${t.id}/adjuntos.zip">Descargar todos (ZIP)</a></div><div class="fx-docs">${tarjetas}</div>`
        : '<p class="fx-nota">El trámite no tiene documentos adjuntos.</p>'}
      ${piezas.entregados || ''}
      <p class="fx-nota">Los documentos se abren desde la plataforma, sin cuenta en Cero Filas. Cada apertura queda registrada.</p>`;
  }

  function relacionados(t) {
    const dup = (STATE.duplicados.get(t.id) || []);
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const email = norm(t.email_solicitante), nombre = norm(t.nombre_solicitante);
    const vistos = new Set([t.id, ...dup.map(r => r.id)]);
    const otros = [...STATE.tramites, ...(STATE.portadaHistorico || [])].filter(x => {
      if (vistos.has(x.id)) return false;
      const ok = (email && norm(x.email_solicitante) === email) || (nombre && nombre.length > 6 && norm(x.nombre_solicitante) === nombre);
      if (ok) vistos.add(x.id);
      return ok;
    }).sort((a, b) => ((b.fecha_inicio || '') > (a.fecha_inicio || '') ? 1 : -1));
    const areas = new Set(t.areas_protegidas || []);
    const mismaArea = areas.size ? STATE.tramites.filter(x => !vistos.has(x.id) && x.estado !== 'rechazado'
      && (x.areas_protegidas || []).some(a => areas.has(a))).slice(0, 12) : [];
    const fila = x => `<li><button data-fx-abrir="${x.id}"><b>#${x.id}</b><span>${escHtml(_tituloTramite(x) || x.titulo_investigacion || nombreProceso(x.proceso_id))}</span>
      <em>${escHtml(x.nombre_solicitante || '')} · ${f(x.fecha_inicio)}</em></button></li>`;
    return {
      n: dup.length + otros.length,
      html: `${dup.length ? `<h4>Posibles duplicados regionales <small>mismo proyecto en otra región; deben consolidarse</small></h4><ul class="fx-rel">${dup.map(fila).join('')}</ul>` : ''}
        <h4>Otros permisos del mismo titular <small>para dar continuidad a sus investigaciones</small></h4>
        ${otros.length ? `<ul class="fx-rel">${otros.map(fila).join('')}</ul>` : '<p class="fx-nota">No hay otros permisos del mismo titular en los años cargados.</p>'}
        ${mismaArea.length ? `<h4>Otros permisos en las mismas áreas protegidas <small>${escHtml([...areas].join(', '))}</small></h4><ul class="fx-rel">${mismaArea.map(fila).join('')}</ul>` : ''}`,
    };
  }

  // ─── Cumplimiento: lo que el titular debe hacer, enlazado con el portal y las entregas ───
  function cumplimiento(t, piezas) {
    const sit = situacionTramite(t);
    const inv = IDS_INVESTIGACION.has(t.proceso_id);
    const plazo = inv ? plazoResultados(t) : null;
    const puedeSubir = !!window.PERFIL?.permisos?.agregar && inv;
    const item = (id, titulo, estado, cuerpo) => `<li class="fx-cum fx-cum--${estado}" id="${id}">
      <div class="fx-cum-cab"><span class="fx-cum-ico" aria-hidden="true">${estado === 'ok' ? '✓' : estado === 'no' ? '!' : '○'}</span><strong>${titulo}</strong></div>
      <div class="fx-cum-cuerpo">${cuerpo}</div></li>`;
    return `<ol class="fx-cums">
      ${item('fx-cum-registro', 'Registro geográfico de los sitios de trabajo', 'espera',
        `<p class="fx-nota" style="margin-top:0">El titular marca sus puntos de muestreo, transectos y parcelas en el <b>portal del investigador</b>, con un enlace y clave temporales que genera el administrador.</p>
         <div id="fx-registro"><div class="empty-msg">Consultando el portal del investigador…</div></div>`)}
      ${inv ? item('fx-cum-n6', 'Entrega de resultados (Numeral 6 del Reglamento)', piezas.entregaOk ? 'ok' : (plazo && new Date() > plazo ? 'no' : 'espera'),
        `${plazo ? `<p>Plazo: <b>${plazo.toLocaleDateString('es-CL')}</b> (3 años desde el término del trámite).</p>` : '<p>El plazo corre desde que termine el trámite.</p>'}
         ${piezas.entregados || '<p class="fx-nota">Aún no hay informes, publicaciones ni material entregado en la carpeta de Drive del titular.</p>'}
         ${puedeSubir ? `<button class="fx-btn" onclick="toggleUploadPanel(${t.id})">Subir lo entregado por el titular</button>
           <table class="bq-upload"><tbody>${_uploadPanelHtml(t)}</tbody></table>` : ''}
         <div id="fx-fotos-titular"></div>`) : ''}
      ${sit === 'cierre_solicitante' ? item('fx-cum-cierre', 'Cerrar el trámite en Cero Filas', 'espera',
        '<p>CONAF ya resolvió; falta que el titular confirme la recepción en su cuenta de Cero Filas. No es atraso de CONAF.</p>') : ''}
      ${item('fx-cum-cond', 'Respetar el período, las áreas y las condiciones de la resolución', sit === 'rechazado' ? 'no' : 'ok',
        `<p>${(() => { const { ini, fin } = periodo(t); return ini ? `Período autorizado: <b>${ini.toLocaleDateString('es-CL')}</b> al <b>${(fin || ini).toLocaleDateString('es-CL')}</b>. ` : ''; })()}
          Áreas: <b>${escHtml((t.areas_protegidas || []).join(', ') || '–')}</b>. Las condiciones están en la resolución (pestaña Documentos).</p>`)}
    </ol>
    ${piezas.cumplimiento ? `<details class="fx-cum-n6"><summary>Detalle del cumplimiento del Numeral 6</summary>${piezas.cumplimiento}</details>` : ''}`;
  }

  // Fotos «desde el terreno» extraídas de los informes de este titular (galería de la Portada)
  async function fotosDelTitular(t) {
    const cont = document.getElementById('fx-fotos-titular');
    if (!cont) return;
    try {
      const fotos = (await (await fetch('/api/fotos')).json()).data || [];
      const nombre = _normInv((t.nombre_solicitante || '').replace(/_/g, ' '));
      const suyas = fotos.filter(x => _normInv(x.investigador) === nombre).slice(0, 8);
      if (suyas.length) cont.innerHTML = `<h4>Fotos extraídas de sus informes <small>aparecen en «Desde el terreno» de la Portada</small></h4>
        <div class="fx-fotos">${suyas.map(x => `<img src="${x.url}" alt="" loading="lazy" title="${escHtml(x.documento)}">`).join('')}</div>`;
    } catch (e) { /* sin fotos */ }
  }

  // ─── Armado ────────────────────────────────────────────────────────────────
  function html(t, piezas) {
    const et = etapas(t);
    const d = t.datos_raw || {};
    const titulo = _tituloTramite(t) || campo(d, /nombre_del_proyecto/, /nombre_proyecto/) || nombreProceso(t.proceso_id);
    const institucion = campo(d, /institucion_patrocinante/, /^nombre_empresa/, /^razon_social/, /^institucion/);
    const res = piezas.adjuntos.find(([k]) => RESOLUCION.test(k));
    const rel = relacionados(t);
    const nCampos = (piezas.solicitudHtml.match(/modal-kv-item/g) || []).length;
    const tabs = [
      ['resumen', 'Resumen', '', resumen(t, piezas)],
      ['solicitud', 'Solicitud completa', nCampos, `<input class="fx-filtro" placeholder="Buscar un dato del formulario…" aria-label="Buscar en la solicitud">${piezas.solicitudHtml}`],
      ['territorio', 'Territorio', '', `${piezas.regiones || '<p class="fx-nota">El formulario no detalla regiones ni áreas.</p>'}
        <div class="fx-enlaces"><button class="fx-btn" data-fx-ir="cumplimiento">Ver los sitios que registró el titular</button>
        ${(t.regiones_list || []).length === 1 && window.PERFIL?.secciones?.some(x => x.startsWith('resumen')) ? `<button class="fx-btn" data-fx-territorio="${escHtml(t.regiones_list[0])}">Ver presión de permisos en la región</button>` : ''}</div>`],
      ['seguimiento', 'Seguimiento CONAF', et.length, seguimiento(t, et)],
      ['documentos', 'Documentos', piezas.adjuntos.length + (piezas.nEntregados || 0), documentos(t, piezas)],
      ['cumplimiento', 'Cumplimiento del titular', '', cumplimiento(t, piezas)],
      ['relacionados', 'Relacionados', rel.n || '', rel.html],
    ];
    return `<div class="fx">
      <header class="fx-cab">
        <div class="fx-cab-txt">
          <div class="fx-chips">${badgeHtml(t.estado, { recepcionPendiente: t.recepcion_pendiente, tramite: t })}${tipoBadgeHtml(t)}<span class="fx-id">#${t.id}</span></div>
          <h2>${escHtml(titulo)}</h2>
          <p>${escHtml(t.nombre_solicitante || 'Sin nombre')}${institucion ? ` · ${escHtml(institucion)}` : ''}${t.email_solicitante
            ? (t.email_solicitante.includes('█') ? ` · ${escHtml(t.email_solicitante)}` : ` · <a href="${safeUrl('mailto:' + t.email_solicitante)}">${escHtml(t.email_solicitante)}</a>`) : ''}</p>
        </div>
        <div class="fx-acciones">
          ${res ? `<a class="fx-btn fx-btn--pri" href="/api/tramites/${t.id}/adjuntos/${encodeURIComponent(res[0])}" target="_blank" rel="noopener">Resolución</a>` : ''}
          ${piezas.adjuntos.length ? `<a class="fx-btn" href="/api/tramites/${t.id}/adjuntos.zip">Adjuntos (ZIP)</a>` : ''}
          <a class="fx-btn" href="${safeUrl(`https://conaf.cerofilas.gob.cl/backend/seguimiento/ver/${t.id}`)}" target="_blank" rel="noopener">Cero Filas ↗</a>
          <button class="fx-btn" data-fx-copiar>Copiar enlace</button>
        </div>
      </header>
      ${!window.PERFIL?.ve_sensible && window.avisoPrivacidad ? `<div class="fx-aviso">${window.avisoPrivacidad()}</div>` : ''}
      ${situacion(t, et, piezas)}
      <div id="fx-tl-host">${lineaDeTiempo(t, et)}</div>
      <nav class="fx-tabs" role="tablist">${tabs.map(([id, nombre, n], i) => `<button role="tab" data-fx-tab="${id}" aria-selected="${i === 0}">${nombre}${n !== '' && n !== 0 ? ` <span>${n}</span>` : ''}</button>`).join('')}</nav>
      ${tabs.map(([id, , , cont], i) => `<section class="fx-panel" data-fx-panel="${id}" role="tabpanel" ${i ? 'hidden' : ''}>${cont}</section>`).join('')}
    </div>`;
  }

  function activar(t) {
    const body = document.getElementById('modal-tramite-body');
    const raiz = body.querySelector('.fx');
    if (!raiz) return;
    const irA = id => raiz.querySelector(`[data-fx-tab="${id}"]`)?.click();
    raiz.addEventListener('click', e => {
      const esc = e.target.closest('[data-fx-escala]');
      if (esc) {
        const abierto = raiz.querySelector('.fx-tl-ayuda')?.open;
        document.getElementById('fx-tl-host').innerHTML = lineaDeTiempo(t, etapas(t), esc.dataset.fxEscala);
        if (abierto) raiz.querySelector('.fx-tl-ayuda').open = true;
        return;
      }
      const ir = e.target.closest('[data-fx-ir]');
      if (ir) return irA(ir.dataset.fxIr);
      const terr = e.target.closest('[data-fx-territorio]');
      if (terr) {
        document.getElementById('modal-tramite').style.display = 'none';
        document.querySelector(`.tab-btn[data-tab="dashboard"][data-tipo="${IDS_INVESTIGACION.has(t.proceso_id) ? 'inv' : 'film'}"]`)?.click();
        if (STATE.region !== terr.dataset.fxTerritorio) setRegion(terr.dataset.fxTerritorio);
        setTimeout(() => document.getElementById('terr-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
        return;
      }
      const tab = e.target.closest('[data-fx-tab]');
      if (tab) {
        raiz.querySelectorAll('[data-fx-tab]').forEach(b => b.setAttribute('aria-selected', String(b === tab)));
        raiz.querySelectorAll('[data-fx-panel]').forEach(p => { p.hidden = p.dataset.fxPanel !== tab.dataset.fxTab; });
        window.dispatchEvent(new Event('resize'));   // el mapa (Leaflet) recalcula su tamaño al hacerse visible
        return;
      }
      const ab = e.target.closest('[data-fx-abrir]');
      if (ab) return openModal(Number(ab.dataset.fxAbrir));
      const cp = e.target.closest('[data-fx-copiar]');
      if (cp) {
        const enlace = `${location.origin}/?tramite=${t.id}`;
        navigator.clipboard?.writeText(enlace).then(() => { cp.textContent = 'Enlace copiado ✓'; }, () => { prompt('Copie el enlace:', enlace); });
      }
    });
    raiz.querySelector('.fx-filtro')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      raiz.querySelectorAll('[data-fx-panel="solicitud"] .modal-kv-item').forEach(el => {
        el.hidden = q && !el.textContent.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q);
      });
    });
    window.RegistroGeo?.montar(t, document.getElementById('fx-registro'), n => {
      const p = document.getElementById('fx-pend-registro');
      if (p && !n) p.textContent = ' Falta el registro geográfico del titular (puntos, transectos o parcelas).';
      const item = document.getElementById('fx-cum-registro');
      if (item && n) { item.className = 'fx-cum fx-cum--ok'; item.querySelector('.fx-cum-ico').textContent = '✓'; }
    });
    fotosDelTitular(t);
  }

  // Enlace directo: /?tramite=ID abre la ficha al terminar de cargar
  document.addEventListener('DOMContentLoaded', async () => {
    const id = new URLSearchParams(location.search).get('tramite');
    if (!/^\d{4,12}$/.test(id || '')) return;
    for (let k = 0; k < 240 && getComputedStyle(document.getElementById('loading-overlay') || document.body).display !== 'none'
      && document.getElementById('loading-overlay')?.offsetParent !== null; k++) await new Promise(r => setTimeout(r, 500));
    openModal(Number(id));
  });

  return { html, activar };
})();

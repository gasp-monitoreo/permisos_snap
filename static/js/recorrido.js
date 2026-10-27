/* ═══════════════════════════════════════════════
   Recorrido guiado: ventanas flotantes que señalan cada parte de la pantalla.
   Los pasos se adaptan al perfil (secciones visibles, región fija, superusuario).
   Se inicia desde el aviso de bienvenida, el menú «Recorrido guiado» o /?recorrido=1.
   ═══════════════════════════════════════════════ */
'use strict';
window.Recorrido = (() => {
  const P = window.PERFIL || {};
  const secs = P.secciones || [];
  const root = document.documentElement;
  const movil = () => window.matchMedia('(max-width: 900px)').matches;
  const tab = (t, tipo) => document.querySelector(`.tab-btn[data-tab="${t}"]${tipo ? `[data-tipo="${tipo}"]` : ''}`);
  const ir = (t, tipo) => () => { const b = tab(t, tipo); if (b && !b.classList.contains('active')) b.click(); };
  const tipoResumen = secs.includes('resumen_inv') ? 'inv' : 'film';
  const nombreResumen = tipoResumen === 'inv' ? 'Investigación' : 'Filmación y Fotografía';

  function pasos() {
    const L = [
      { titulo: 'Bienvenido/a a Permisos SNAP',
        texto: 'Este recorrido le muestra, paso a paso, para qué sirve cada parte de la pantalla. Dura unos 2 minutos. Puede avanzar con los botones o con las flechas del teclado, y salir cuando quiera.' },
      { sel: '.sb-nav', menu: true, titulo: 'El menú',
        texto: 'Desde aquí cambia de sección. Solo aparecen las secciones que su perfil tiene habilitadas.' },
    ];
    if (!movil()) L.push({ sel: '#sb-toggle', titulo: 'Achicar el menú',
      texto: 'Este botón contrae el menú para dejar más espacio a los gráficos. Vuelva a pulsarlo para expandirlo.' });
    else L.push({ sel: '#topbar-menu', titulo: 'Abrir el menú en el celular',
      texto: 'En el celular el menú se esconde. Pulse este botón para abrirlo y elegir una sección.' });
    if (secs.includes('portada')) L.push(
      { sel: '#tab-portada .hero', antes: ir('portada'), titulo: 'La Portada',
        texto: 'Es lo primero que ve al entrar: un resumen nacional de los permisos con fotografías tomadas por los propios investigadores.' },
      { sel: '#panorama', antes: ir('portada'), titulo: 'Cifras y gráficos',
        texto: 'Muestra cuántos permisos hay por año, por región y por tema. Pase el mouse (o toque) sobre una barra para ver el detalle.' });
    L.push(
      { sel: '.header-rango', titulo: 'Años a revisar',
        texto: 'Elija desde qué año y hasta qué año quiere ver la información. Todos los gráficos y tablas se actualizan solos.' },
      { sel: '#btn-refresh', titulo: 'Actualizar',
        texto: 'Trae los datos más recientes desde CeroFilas. Normalmente no lo necesita: la plataforma se mantiene al día sola.' });
    if (secs.includes('resumen_inv') || secs.includes('resumen_film')) L.push(
      { sel: '#atencion .atn-cards', antes: ir('dashboard', tipoResumen), titulo: `Resumen de ${nombreResumen}: lo que requiere atención`,
        texto: 'Arriba está lo que pide acción hoy: solicitudes atrasadas en CONAF, las que vencen en los próximos 7 días y las que esperan respuesta del solicitante. La frase de arriba resume la situación.' },
      { sel: '#atencion .atn-card', antes: ir('dashboard', tipoResumen), titulo: 'Detalle a pedido',
        texto: 'Pulse el botón de una tarjeta para ver la lista en un panel lateral; desde ahí abre cada trámite. Si pulsa una región, la vista se acerca a esa región y agrupa por área protegida.' },
      { sel: '#filtro-regiones', antes: ir('dashboard', tipoResumen), titulo: 'El ámbito: región y área protegida',
        texto: P.solo_su_region && P.region
          ? `Su perfil está fijo en ${P.region}. Elija un área protegida para que todo el panel muestre solo esa área. «A mi cargo» deja solo los permisos cuya etapa actual está asignada a usted.`
          : 'Elija una región y, si quiere, un área protegida: TODO el panel (tarjetas, mapa, gráficos y tabla) se ajusta a ese ámbito. «A mi cargo» deja solo los permisos cuya etapa actual está asignada a usted.' },
      { sel: '#terr-card', antes: ir('dashboard', tipoResumen), titulo: 'Dónde se concentran los permisos',
        texto: 'El mapa también cambia el ámbito: pulse una región o un área protegida para acercar todo el panel. Dentro de un área verá el calendario de actividades y si los sitios de distintos permisos se superponen.' },
      { sel: '#desempeno', antes: () => { ir('dashboard', tipoResumen)(); const d = document.getElementById('desempeno'); if (d) d.open = true; }, titulo: 'Desempeño del período',
        texto: 'Las cifras y gráficos (ingresos, tiempos de resolución, pendientes por oficina y regiones) quedan aquí, plegados para no competir con lo urgente. Ábralos cuando necesite el panorama completo.' });
    if (secs.includes('busqueda')) L.push(
      { sel: '#bq-q', antes: ir('busqueda'), titulo: 'Buscar un trámite',
        texto: 'Los resultados aparecen mientras escribe, en todos los años y sin importar tildes. Use los filtros de la izquierda (tipo, situación, región, área, tema) y los atajos para encontrar lo urgente.' });
    if (secs.includes('exportar')) L.push(
      { sel: '#btn-descargar-excel', antes: ir('exportar'), titulo: 'Exportar a Excel',
        texto: 'Descarga los trámites en una planilla Excel, con los filtros de estado, tipo y fechas que elija arriba.' });
    if (P.superusuario && tab('usuarios')) L.push(
      { sel: '#usr-btn-nuevo', antes: ir('usuarios'), titulo: 'Administrar usuarios',
        texto: 'Solo usted ve esta sección: crea cuentas, define secciones y permisos de cada persona y restablece claves olvidadas.' },
      { sel: '#usr-btn-planilla', antes: ir('usuarios'), titulo: 'Planilla de claves',
        texto: 'Descarga un Excel protegido con su propia clave, con las claves temporales de quienes aún no definen la suya.' });
    L.push(
      { sel: '.sb-footer', menu: true, titulo: 'Ayuda y cuenta',
        texto: 'Aquí está el manual (también en PDF), este recorrido para repetirlo cuando quiera, el cambio de su clave y el botón para cerrar sesión.' },
      { titulo: '¡Listo!',
        texto: 'Ya conoce la plataforma. Si tiene dudas, abra el «Manual» desde el menú: explica cada función con imágenes.', fin: true });
    return L;
  }

  let L = [], i = 0, capa, hueco, caja, inicioTab;

  function construir() {
    capa = Object.assign(document.createElement('div'), { className: 'rec-capa' });
    hueco = Object.assign(document.createElement('div'), { className: 'rec-hueco' });
    caja = Object.assign(document.createElement('div'), { className: 'rec-caja' });
    caja.setAttribute('role', 'dialog');
    caja.setAttribute('aria-live', 'polite');
    capa.append(hueco, caja);
    document.body.appendChild(capa);
    caja.addEventListener('click', e => {
      const a = e.target.closest('[data-rec]')?.dataset.rec;
      if (a === 'sig') mover(1);
      else if (a === 'ant') mover(-1);
      else if (a === 'salir') terminar();
    });
    document.addEventListener('keydown', teclas);
    window.addEventListener('resize', ubicar);
    window.addEventListener('scroll', ubicar, true);
  }

  function teclas(e) {
    if (e.key === 'Escape') terminar();
    else if (e.key === 'ArrowRight') mover(1);
    else if (e.key === 'ArrowLeft') mover(-1);
  }

  const visible = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const objetivo = () => (L[i].sel ? document.querySelector(L[i].sel) : null);

  function mover(d) {
    let j = i + d;
    // salta pasos cuyo elemento no existe o no se ve en este perfil/pantalla
    while (j >= 0 && j < L.length) {
      i = j;
      preparar();
      if (!L[i].sel || visible(objetivo())) break;
      j += d;
    }
    if (j < 0 || j >= L.length) { if (j >= L.length) terminar(); return; }
    mostrar();
  }

  function preparar() {
    const s = L[i];
    if (s.antes) s.antes();
    if (movil()) root.classList.toggle('sb-open', !!s.menu);
  }

  function mostrar() {
    const s = L[i], el = objetivo();
    const n = L.length;
    caja.innerHTML = `
      <button class="rec-x" data-rec="salir" aria-label="Salir del recorrido">✕</button>
      <div class="rec-paso">Paso ${i + 1} de ${n}</div>
      <div class="rec-barra"><i style="width:${((i + 1) / n) * 100}%"></i></div>
      <h4>${s.titulo}</h4>
      <p>${s.texto}</p>
      <div class="rec-botones">
        ${i > 0 ? '<button class="btn-secondary" data-rec="ant">← Anterior</button>' : '<button class="btn-secondary" data-rec="salir">Salir</button>'}
        <button class="btn-primary" data-rec="sig">${s.fin ? 'Terminar' : 'Siguiente →'}</button>
      </div>`;
    capa.classList.toggle('sin-objetivo', !el);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(ubicar, el ? 380 : 0);
    ubicar();
    caja.querySelector('[data-rec=sig]').focus({ preventScroll: true });
  }

  function ubicar() {
    if (!capa) return;
    const el = objetivo(), M = 10, vw = innerWidth, vh = innerHeight;
    if (!el) {
      hueco.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0`;
      caja.style.cssText = `left:${Math.max(16, (vw - caja.offsetWidth) / 2)}px;top:${Math.max(16, (vh - caja.offsetHeight) / 2)}px`;
      return;
    }
    const r = el.getBoundingClientRect();
    const top = Math.max(r.top - 6, 4), left = Math.max(r.left - 6, 4);
    const w = Math.min(r.width + 12, vw - left - 4), h = Math.min(r.height + 12, vh - top - 4);
    hueco.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${h}px`;
    if (vw < 700) { caja.style.cssText = ''; caja.classList.add('rec-abajo'); return; }   // hoja inferior en celular
    caja.classList.remove('rec-abajo');
    const cw = caja.offsetWidth, ch = caja.offsetHeight;
    let x, y;
    if (top + h + M + ch < vh) { y = top + h + M; x = left; }                 // debajo
    else if (top - M - ch > 0) { y = top - M - ch; x = left; }                // encima
    else if (left + w + M + cw < vw) { x = left + w + M; y = top; }           // derecha
    else { x = left - M - cw; y = top; }                                       // izquierda
    x = Math.min(Math.max(x, 16), vw - cw - 16);
    y = Math.min(Math.max(y, 16), vh - ch - 16);
    caja.style.cssText = `left:${x}px;top:${y}px`;
  }

  function terminar() {
    if (!capa) return;
    document.removeEventListener('keydown', teclas);
    window.removeEventListener('resize', ubicar);
    window.removeEventListener('scroll', ubicar, true);
    capa.remove(); capa = null;
    root.classList.remove('sb-open');
    if (inicioTab && !inicioTab.classList.contains('active')) inicioTab.click();   // vuelve a donde estaba
  }

  async function iniciar() {
    if (capa) return;
    // espera a que termine la carga inicial de datos (máx. 60 s)
    for (let k = 0; k < 120 && visible(document.getElementById('loading-overlay')); k++) {
      await new Promise(r => setTimeout(r, 500));
    }
    inicioTab = document.querySelector('.sb-nav .tab-btn.active');
    L = pasos(); i = -1;
    construir();
    mover(1);
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-recorrido')?.addEventListener('click', iniciar);
    const url = new URL(location.href);
    if (url.searchParams.has('recorrido')) {
      url.searchParams.delete('recorrido');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      setTimeout(iniciar, 300);
    }
  });
  return { iniciar, terminar };
})();

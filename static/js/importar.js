// Carga manual de trámites desde CeroFilas (solo superusuario).
// Mientras el WAF de CeroFilas pida CAPTCHA, el servidor no puede consultar su API:
// el superusuario descarga los trámites con el marcador desde su navegador y sube el archivo.
(function () {
  const $c = id => document.getElementById(id);
  const modal = $c('modal-cerofilas');
  if (!modal || !$c('btn-cerofilas')) return;

  const fecha = ts => new Date(ts * 1000).toLocaleString('es-CL', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function estado() {
    const el = $c('cf-estado');
    try {
      const d = await (await fetch('/api/cerofilas/estado')).json();
      if (!d.ok) throw new Error(d.error || 'sin respuesta');
      const partes = [d.bloqueado
        ? '⛔ CeroFilas está bloqueando las consultas automáticas de la plataforma (CAPTCHA).'
        : 'La plataforma no tiene un bloqueo registrado en los últimos 30 minutos.'];
      const u = d.ultima;
      partes.push(u
        ? `Última carga manual: <b>${fecha(u.ts)}</b> · ${u.tramites} trámites (${u.modo === 'completo' ? 'completa' : 'cambios'}).`
        : 'Aún no se ha hecho ninguna carga manual.');
      if (u && Date.now() / 1000 - u.ts > 36 * 3600) partes.push('⚠️ Han pasado más de 36 horas: conviene actualizar.');
      el.innerHTML = partes.join('<br>');
    } catch (e) {
      el.textContent = 'No se pudo consultar el estado: ' + e.message;
    }
  }

  async function prepararMarcador() {
    const a = $c('cf-marcador');
    if (a.dataset.listo) return;
    try {
      const d = await (await fetch('/api/cerofilas/marcador')).json();
      if (!d.ok) throw new Error(d.error);
      a.href = 'javascript:' + encodeURIComponent(d.codigo);
      a.dataset.listo = '1';
    } catch (e) {
      a.textContent = 'No se pudo preparar el marcador';
    }
  }

  $c('cf-marcador').addEventListener('click', e => {
    e.preventDefault();
    alert('Este botón no se presiona aquí: arrástrelo a la barra de marcadores y úselo en una pestaña de CeroFilas.');
  });

  $c('btn-cerofilas').addEventListener('click', () => {
    modal.style.display = 'flex';
    $c('cf-resultado').hidden = true;
    estado();
    prepararMarcador();
  });
  modal.addEventListener('click', e => {
    if (e.target === modal || e.target.closest('[data-cerrar-cf]')) modal.style.display = 'none';
  });

  $c('cf-form').addEventListener('submit', async e => {
    e.preventDefault();
    const archivo = $c('cf-archivo').files[0];
    if (!archivo) return;
    const res = $c('cf-resultado');
    const boton = e.target.querySelector('button');
    res.hidden = false;
    res.className = 'cf-resultado';
    res.textContent = `Cargando ${archivo.name}… (puede tardar un minuto)`;
    boton.disabled = true;
    try {
      const fd = new FormData();
      fd.append('archivo', archivo);
      const d = await (await fetch('/api/cerofilas/importar', { method: 'POST', body: fd })).json();
      if (!d.ok) throw new Error(d.error || 'error desconocido');
      const r = d.resumen;
      res.classList.add('cf-ok');
      res.innerHTML = `✅ Se cargaron <b>${r.tramites}</b> trámites (años ${esc(r.anios.join(', '))}). ` +
        'La página se recargará para mostrar los datos nuevos.';
      setTimeout(() => location.reload(), 2500);
    } catch (err) {
      res.classList.add('cf-error');
      res.textContent = '❌ ' + err.message;
    } finally {
      boton.disabled = false;
    }
  });
})();

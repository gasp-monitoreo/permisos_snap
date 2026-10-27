/* ═══════════════════════════════════════════════
   Usuarios (solo superusuario): perfiles, secciones, permisos y claves.
   API: /api/usuarios… (tramites/api.py). Usa _esc de panorama.js.
   ═══════════════════════════════════════════════ */
'use strict';
(() => {
  const $u = id => document.getElementById(id);
  const TIPOS = { inv: 'Investigación', film: 'Filmación y fotografía', ambos: 'Investigación y filmación', nacional: 'Nacional' };
  let usuarios = [], secciones = {}, regiones = [], editando = null;

  const csrf = () => (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  async function api(url, opciones = {}) {
    const r = await fetch(url, {
      ...opciones,
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf(), ...(opciones.headers || {}) },
    });
    const ct = r.headers.get('Content-Type') || '';
    const datos = ct.includes('json') ? await r.json() : null;
    if (!r.ok || (datos && datos.ok === false)) throw new Error((datos && datos.error) || `Error ${r.status}`);
    return datos;
  }
  const abrir = id => { $u(id).style.display = 'flex'; };
  const cerrar = id => { $u(id).style.display = 'none'; };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-cerrar]');
    if (b) cerrar(b.dataset.cerrar);
  });

  function mostrarClave(usuario, clave) {
    $u('usr-clave-para').innerHTML = `Clave temporal de <strong>${_esc(usuario.nombre || usuario.email)}</strong> (${_esc(usuario.email)}):`;
    $u('usr-clave-valor').textContent = clave;
    abrir('modal-clave');
  }
  $u('usr-clave-copiar').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($u('usr-clave-valor').textContent); $u('usr-clave-copiar').textContent = 'Copiada ✓'; }
    catch { $u('usr-clave-copiar').textContent = 'Seleccione y copie'; }
    setTimeout(() => { $u('usr-clave-copiar').textContent = 'Copiar'; }, 2000);
  });

  // ── Tabla ───────────────────────────────────────────────────────────────
  function pintar() {
    const q = $u('usr-buscar').value.trim().toLowerCase();
    const tipo = $u('usr-filtro-tipo').value;
    const lista = usuarios.filter(u =>
      (!tipo || u.tipo === tipo) &&
      (!q || `${u.nombre} ${u.email} ${u.region}`.toLowerCase().includes(q)));
    if (!lista.length) { $u('usr-tabla').innerHTML = '<div class="empty-msg">Sin usuarios que coincidan.</div>'; return; }
    const fecha = iso => iso ? new Date(iso).toLocaleString('es-CL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Nunca';
    const permisos = u => u.superusuario ? '<span class="usr-chip usr-chip--total">Todo</span>' :
      ['agregar', 'editar', 'borrar'].map(a => `<span class="usr-perm ${u.permisos[a] ? 'si' : ''}" title="${a}">${a[0].toUpperCase()}</span>`).join('');
    const estado = u => !u.activo ? '<span class="usr-estado inactivo">Inactiva</span>'
      : u.clave_pendiente ? '<span class="usr-estado pendiente">Clave temporal</span>'
      : '<span class="usr-estado activa">Activa</span>';
    $u('usr-tabla').innerHTML = `<table class="usr-table">
      <thead><tr><th>Nombre</th><th>Perfil</th><th>Región</th><th>Secciones</th><th title="Agregar · Editar · Borrar">Permisos</th><th>Estado</th><th>Último ingreso</th><th></th></tr></thead>
      <tbody>${lista.map(u => `<tr data-id="${u.id}">
        <td><strong>${_esc(u.nombre || '—')}</strong><br><small>${_esc(u.email)}</small></td>
        <td>${u.superusuario ? 'Superusuario' : _esc(TIPOS[u.tipo] || u.tipo)}</td>
        <td>${_esc(u.region || 'Nacional')}${u.solo_su_region ? ' <span class="usr-candado" title="Solo ve su región">🔒</span>' : ''}</td>
        <td class="usr-secs">${u.secciones.map(s => `<span class="usr-chip">${_esc((secciones[s] || s).split(' (')[0])}</span>`).join('')}</td>
        <td>${permisos(u)}</td>
        <td>${estado(u)}</td>
        <td><small>${fecha(u.ultimo_ingreso)}</small></td>
        <td class="usr-acc">${u.superusuario ? '' : `
          <button data-acc="editar" title="Editar perfil y permisos">✏️</button>
          <button data-acc="clave" title="Restablecer clave (si la olvidó)">🔑</button>
          <button data-acc="borrar" title="Eliminar usuario">🗑️</button>`}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  async function cargar() {
    try {
      const d = await api('/api/usuarios');
      usuarios = d.data; secciones = d.secciones; regiones = d.regiones;
      const sel = $u('usr-form').elements.region;
      if (sel.options.length <= 1) regiones.forEach(r => sel.add(new Option(r, r)));
      $u('usr-secciones').innerHTML = Object.entries(secciones).map(([k, v]) =>
        `<label class="usr-check"><input type="checkbox" name="sec" value="${k}" /> ${_esc(v)}</label>`).join('');
      pintar();
    } catch (e) {
      $u('usr-tabla').innerHTML = `<div class="empty-msg">No se pudo cargar la lista (${_esc(e.message)}).</div>`;
    }
  }

  // ── Formulario ──────────────────────────────────────────────────────────
  function abrirFormulario(u) {
    editando = u || null;
    const f = $u('usr-form').elements;
    $u('usr-modal-titulo').textContent = u ? `Editar · ${u.nombre || u.email}` : 'Nuevo usuario';
    f.nombre.value = u ? u.nombre : '';
    f.email.value = u ? u.email : '';
    f.email.disabled = !!u;                 // el correo es el usuario: no se cambia
    f.tipo.value = u ? u.tipo : 'inv';
    f.region.value = u ? u.region : '';
    f.solo_su_region.checked = u ? u.solo_su_region : true;
    f.areas.value = u ? (u.areas || []).join('\n') : '';
    f.activo.checked = u ? u.activo : true;
    const secs = u ? u.secciones : ['portada', 'busqueda', 'resumen_inv'];
    [...document.querySelectorAll('#usr-secciones input')].forEach(c => { c.checked = secs.includes(c.value); });
    ['agregar', 'editar', 'borrar'].forEach(a => { f[`perm_${a}`].checked = u ? u.permisos[a] : false; });
    abrir('modal-usuario');
  }
  // Al elegir el perfil en un usuario nuevo, sugerir las secciones de su tipo
  $u('usr-form').elements.tipo.addEventListener('change', e => {
    if (editando) return;
    const t = e.target.value;
    const sugeridas = ['portada', 'busqueda', ...(t === 'film' ? [] : ['resumen_inv']), ...(t === 'inv' ? [] : ['resumen_film'])];
    document.querySelectorAll('#usr-secciones input').forEach(c => { c.checked = sugeridas.includes(c.value); });
  });

  $u('usr-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    const datos = {
      nombre: f.nombre.value.trim(), email: f.email.value.trim(), tipo: f.tipo.value, region: f.region.value,
      solo_su_region: f.solo_su_region.checked, activo: f.activo.checked,
      areas: f.areas.value.split('\n').map(a => a.trim()).filter(Boolean),
      secciones: [...document.querySelectorAll('#usr-secciones input:checked')].map(c => c.value),
      permisos: { agregar: f.perm_agregar.checked, editar: f.perm_editar.checked, borrar: f.perm_borrar.checked },
    };
    try {
      if (editando) {
        await api(`/api/usuarios/${editando.id}`, { method: 'PUT', body: JSON.stringify(datos) });
        cerrar('modal-usuario');
      } else {
        const r = await api('/api/usuarios', { method: 'POST', body: JSON.stringify(datos) });
        cerrar('modal-usuario');
        mostrarClave(r.usuario, r.clave_temporal);
      }
      cargar();
    } catch (err) { alert(err.message); }
  });

  // ── Acciones por fila ───────────────────────────────────────────────────
  $u('usr-tabla').addEventListener('click', async e => {
    const b = e.target.closest('[data-acc]');
    if (!b) return;
    const u = usuarios.find(x => x.id === Number(b.closest('tr').dataset.id));
    if (b.dataset.acc === 'editar') return abrirFormulario(u);
    if (b.dataset.acc === 'clave') {
      if (!confirm(`¿Restablecer la clave de ${u.nombre || u.email}?\nSu clave actual dejará de funcionar y deberá definir una nueva al ingresar.`)) return;
      try { const r = await api(`/api/usuarios/${u.id}/restablecer`, { method: 'POST' }); mostrarClave(r.usuario, r.clave_temporal); cargar(); }
      catch (err) { alert(err.message); }
    }
    if (b.dataset.acc === 'borrar') {
      if (!confirm(`¿Eliminar la cuenta de ${u.nombre || u.email}? Esta acción no se puede deshacer.\n(Si solo quiere suspenderla, edítela y desmarque «Cuenta activa».)`)) return;
      try { await api(`/api/usuarios/${u.id}`, { method: 'DELETE' }); cargar(); }
      catch (err) { alert(err.message); }
    }
  });

  $u('usr-btn-nuevo').addEventListener('click', () => abrirFormulario(null));
  $u('usr-buscar').addEventListener('input', pintar);
  $u('usr-filtro-tipo').addEventListener('change', pintar);

  $u('usr-btn-encargados').addEventListener('click', async () => {
    const b = $u('usr-btn-encargados');
    b.disabled = true; b.textContent = 'Buscando…';
    try {
      const r = await api('/api/usuarios/encargados', { method: 'POST' });
      const vacias = r.encargados.filter(x => !x.email).map(x => `${x.region} (${x.tipo === 'inv' ? 'investigación' : 'filmación'})`);
      alert(`Cuentas nuevas: ${r.creados.length}` + (r.actualizados.length ? ` · actualizadas: ${r.actualizados.length}` : '') +
            (vacias.length ? `\n\nSin encargado identificable en los trámites:\n• ${vacias.join('\n• ')}` : ''));
      cargar();
    } catch (err) { alert(err.message); }
    finally { b.disabled = false; b.textContent = 'Buscar encargados en trámites'; }
  });

  // ── Planilla con claves ─────────────────────────────────────────────────
  $u('usr-btn-planilla').addEventListener('click', () => {
    $u('usr-form-planilla').reset();
    $u('usr-planilla-error').textContent = '';
    abrir('modal-planilla');
    $u('usr-form-planilla').elements.password.focus();
  });
  $u('usr-form-planilla').addEventListener('submit', async e => {
    e.preventDefault();
    const boton = e.target.querySelector('[type=submit]');
    boton.disabled = true; boton.textContent = 'Generando…';
    $u('usr-planilla-error').textContent = '';
    try {
      const r = await fetch('/api/usuarios/planilla', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() },
        body: JSON.stringify({ password: e.target.elements.password.value }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || `Error ${r.status}`);
      const blob = await r.blob();
      const nombre = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'usuarios.xlsx';
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      cerrar('modal-planilla');
      cargar();
    } catch (err) {
      $u('usr-planilla-error').textContent = err.message;
    } finally {
      e.target.elements.password.value = '';
      boton.disabled = false; boton.textContent = 'Descargar';
    }
  });

  // Cargar al abrir la sección
  document.querySelector('.tab-btn[data-tab="usuarios"]')?.addEventListener('click', cargar);
})();

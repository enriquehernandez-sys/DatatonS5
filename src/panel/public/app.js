/**
 * Panel de integridad — interfaz.
 * Seguridad: todo texto proveniente del servidor se inserta con textContent (nunca innerHTML),
 * y la CSP solo permite scripts y estilos de este mismo origen.
 */

// ---------------------------------------------------------------- utilidades DOM
const SVGNS = 'http://www.w3.org/2000/svg';
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: permitido por la CSP (los atributos style no)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}
const ICONS = {
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z',
  shieldCheck: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3zM8.5 12l2.5 2.5 4.5-5',
  alert: 'M12 4l9 16H3L12 4zM12 10v4M12 17.2v.1',
  octagon: 'M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5zM12 8v5M12 16.2v.1',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  circle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 7.8v.1',
  refresh: 'M20 11a8 8 0 0 0-14.5-4.5M4 4v3.5h3.5M4 13a8 8 0 0 0 14.5 4.5M20 20v-3.5h-3.5',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8',
  dash: 'M6 12h12',
  x: 'M6 6l12 12M18 6L6 18',
};
function icon(name, cls) {
  return s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: cls },
    s('path', { d: ICONS[name] }));
}

// ---------------------------------------------------------------- formato
const nf = new Intl.NumberFormat('es-MX');
const fmtNum = (n) => (n === null || n === undefined ? '—' : nf.format(n));
const fmtSupp = (n, umbral) => (n === null ? `<${umbral}` : nf.format(n));
const dtf = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const dayf = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayShort = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtDate = (iso) => (iso ? dtf.format(new Date(iso)) : '—');
const fmtDay = (d) => (d ? dayf.format(new Date(`${d}T12:00:00Z`)) : '—');
const shortHash = (x) => (x ? `${x.slice(0, 10)}…${x.slice(-6)}` : '—');
function relTime(iso) {
  if (!iso) return 'nunca';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'hace un momento';
  if (m < 60) return `hace ${m} min`;
  const hrs = Math.round(m / 60);
  if (hrs < 48) return `hace ${hrs} h`;
  return `hace ${Math.round(hrs / 24)} días`;
}

const ROL = { publico: 'Público', contralor: 'Contralor interno', administrador: 'Administrador' };
const SEV = { critica: ['Crítica', 'octagon'], alta: ['Alta', 'alert'], media: ['Media', 'alert'], baja: ['Baja', 'info'] };
const EST = { abierta: ['Abierta', 'circle'], en_revision: ['En revisión', 'clock'], atendida: ['Atendida', 'check'], falso_positivo: ['Falso positivo', 'dash'] };
const OPS = { alta: 'Alta', modificacion: 'Modificación', baja: 'Baja' };
const ORIGEN = { flujo: 'Flujo de eventos', conciliacion: 'Conciliación', worker: 'Servicio de sellado', api: 'API de verificación', panel: 'Panel de monitoreo' };
const ALCANCE = { cadena: 'Cadena de bloques', denuncia: 'Una denuncia', sistema: 'Sistema de origen' };
const ACCION = {
  inicio_sesion: 'Inicio de sesión', cierre_sesion: 'Cierre de sesión', consulta_alertas: 'Consulta de anomalías',
  consulta_alerta: 'Detalle de anomalía', seguimiento_alerta: 'Seguimiento de anomalía', consulta_denuncia: 'Consulta de denuncia',
  consulta_bitacora: 'Consulta de bitácora', consulta_operacion: 'Estado operativo', verificacion_manual: 'Verificación manual',
  acceso_denegado: 'Acceso denegado',
};
const DETALLE = {
  operacion: 'Operación', version: 'Versión registrada', versionSellada: 'Versión sellada', hashAnterior: 'Huella anterior',
  hashNuevo: 'Huella nueva', hashActual: 'Huella vigente en el S5', ultimoHashSellado: 'Última huella sellada', entryId: 'Entrada',
  documentoExiste: '¿Existe en el S5?', errores: 'Errores', totalErrores: 'Total de errores', bloquesVerificados: 'Bloques verificados',
  cabeza: 'Cabeza de la cadena', codigo: 'Código', en: 'Momento', coleccion: 'Colección',
};
const badge = (cls, label, ic) => h('span', { class: `badge ${cls}` }, ic ? icon(ic) : null, label);
const sevBadge = (sv) => badge(`b-${sv}`, SEV[sv]?.[0] ?? sv, SEV[sv]?.[1]);
const estBadge = (st) => badge(`b-${st}`, EST[st]?.[0] ?? st, EST[st]?.[1]);

// ---------------------------------------------------------------- API
let idleTimer = null;
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`api${path}`, {
    method, credentials: 'same-origin',
    headers: { 'x-panel': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* sin cuerpo */ }
  if (isPriv()) armIdle();
  if (!r.ok) {
    const e = new Error(data?.error ?? `Error ${r.status}`);
    Object.assign(e, { status: r.status, data });
    if (r.status === 401 && isPriv()) { session = { rol: 'publico' }; renderChrome('Su sesión terminó. Vuelva a iniciar sesión para consultar información reservada.'); }
    throw e;
  }
  return data;
}

// ---------------------------------------------------------------- sesión
let session = { rol: 'publico' };
let catalogo = { tipos: [], umbralSupresion: 5 };
const isPriv = () => session.rol === 'contralor' || session.rol === 'administrador';
const isAdmin = () => session.rol === 'administrador';

function armIdle() {
  clearTimeout(idleTimer);
  const min = session.inactividadMin ?? 30;
  idleTimer = setTimeout(async () => {
    session = await api('/sesion').catch(() => ({ rol: 'publico' }));
    if (!isPriv()) { renderChrome('La sesión se cerró por inactividad.'); route(); }
  }, min * 60_000 + 2000);
}

function renderChrome(flash) {
  const tabs = [
    ['panorama', 'Panorama'], ['bloques', 'Bloques'], ['anomalias', 'Anomalías'],
    ...(isPriv() ? [['denuncia', 'Consulta de denuncia', true]] : []),
    ...(isAdmin() ? [['bitacora', 'Bitácora', true], ['operacion', 'Operación', true]] : []),
  ];
  const current = location.hash.split('/')[1] || 'panorama';
  $('#tabs').replaceChildren(...tabs.map(([id, label, priv]) =>
    h('a', { href: `#/${id}`, class: priv ? 'priv' : null, 'aria-current': current === id ? 'page' : null, title: priv ? 'Sección restringida' : null }, label)));

  const sess = $('#session');
  if (isPriv()) {
    sess.replaceChildren(
      h('span', { class: 'chip priv', title: session.nombre }, icon('lock'), ROL[session.rol]),
      h('button', { class: 'btn small ghost', type: 'button', onclick: logout, title: 'Cerrar sesión' }, icon('logout'), 'Salir'),
    );
  } else {
    sess.replaceChildren(h('button', { class: 'btn small', type: 'button', onclick: openLogin }, icon('lock'), 'Acceso restringido'));
  }

  const notice = isPriv()
    ? h('div', { class: 'priv' }, icon('lock'), h('span', {},
      h('strong', { text: `Información reservada · ${session.nombre} (${ROL[session.rol]}). ` }),
      'Cada consulta queda registrada en la bitácora de accesos. Trate los datos conforme a la legislación de protección de datos personales; ',
      `la sesión se cierra tras ${session.inactividadMin ?? 30} minutos sin actividad.`))
    : h('div', {}, icon('eye'), h('span', {},
      h('strong', { text: 'Vista pública. ' }),
      'Solo se muestran indicadores agregados y huellas criptográficas. No se publican números de denuncia, huellas de documentos ni datos de personas.'));
  $('#notice').replaceChildren(...(flash ? [h('div', { class: 'priv', role: 'alert' }, icon('info'), h('span', { text: flash }))] : []), notice);
  if (flash) $('#notice').firstChild.style.marginBottom = '8px';
}

function openLogin() {
  const dlg = $('#login');
  $('#login-form').reset();
  $('#login-error').hidden = true;
  dlg.showModal();
  dlg.querySelector('input[name=usuario]').focus();
}
$('#login-cancel').addEventListener('click', () => $('#login').close());
$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const btn = $('#login-submit');
  btn.disabled = true;
  try {
    await api('/sesion', { method: 'POST', body: { usuario: f.get('usuario'), contrasena: f.get('contrasena') } });
    session = await api('/sesion');
    $('#login').close();
    renderChrome();
    route();
  } catch (e) {
    const err = $('#login-error');
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
async function logout() {
  await api('/sesion', { method: 'DELETE' }).catch(() => {});
  session = { rol: 'publico' };
  clearTimeout(idleTimer);
  renderChrome('Sesión cerrada.');
  route();
}

// ---------------------------------------------------------------- tooltip
const tip = () => $('#tooltip');
function showTip(ev, content) {
  const t = tip();
  t.replaceChildren(...content);
  t.hidden = false;
  const pad = 14;
  const { innerWidth: W, innerHeight: H } = window;
  const r = t.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + r.width > W - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > H - 8) y = ev.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { tip().hidden = true; };

// ---------------------------------------------------------------- vistas
function $(sel, root = document) { return root.querySelector(sel); }
const main = () => $('#contenido');
let refreshTimer = null;
const loading = () => h('div', { class: 'loading', text: 'Cargando…' });
const errorBox = (e) => h('div', { class: 'err-box', role: 'alert' }, e.message ?? String(e));
const card = (attrs, ...children) => h('section', { ...attrs, class: `card ${attrs.class ?? ''}` }, ...children);
const cardHead = (title, sub, ...extra) => h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: title }), sub ? h('p', { text: sub }) : null), ...extra);
const pageHead = (title, sub, ...extra) => h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: title }), sub ? h('p', { text: sub }) : null), ...extra);
const reservedTag = () => h('span', { class: 'reserved-tag' }, icon('lock'), 'Reservado');
const facts = (rows) => h('dl', { class: 'facts' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v ?? '—')]));
const mono = (x) => h('span', { class: 'mono', text: x ?? '—' });

const GLOBAL = {
  integra: { cls: 'st-good', ic: 'shieldCheck', t: 'Cadena íntegra', d: 'La última verificación criptográfica fue exitosa y no hay anomalías abiertas.' },
  en_observacion: { cls: 'st-warning', ic: 'alert', t: 'En observación', d: '' },
  comprometida: { cls: 'st-critical', ic: 'octagon', t: 'Integridad comprometida', d: 'Se detectó una inconsistencia crítica. La Contraloría interna ha sido notificada para su revisión.' },
  sin_verificar: { cls: 'st-neutral', ic: 'info', t: 'Sin verificación reciente', d: 'Aún no se registra una verificación integral de la cadena.' },
};

async function viewPanorama() {
  const root = main();
  root.replaceChildren(loading());
  const [r, act, alertas] = await Promise.all([api('/publico/resumen'), api('/publico/actividad'), api('/publico/alertas')]);
  const g = GLOBAL[r.estado] ?? GLOBAL.sin_verificar;
  let desc = g.d;
  if (r.estado === 'en_observacion') {
    const motivos = [];
    if (r.alertas.abiertas) motivos.push(`${r.alertas.abiertas} ${r.alertas.abiertas === 1 ? 'anomalía abierta' : 'anomalías abiertas'} en revisión`);
    if (r.sellado.estado === 'detenido') motivos.push('el servicio de sellado no ha reportado actividad reciente');
    if (r.sellado.pendienteMasAntiguoMin > 15) motivos.push(`hay cambios esperando sellarse desde hace ${r.sellado.pendienteMasAntiguoMin} min`);
    desc = `La cadena es válida, pero ${motivos.join('; ')}.`;
  }

  const hero = card({ class: `hero ${g.cls}` },
    h('div', { class: 'hero-icon' }, icon(g.ic)),
    h('div', {}, h('h1', { text: g.t }), h('p', { text: desc })),
    h('div', { class: 'hero-meta' },
      h('div', {}, 'Última verificación'),
      h('strong', { text: r.verificacion ? relTime(r.verificacion.verificadoEn) : 'nunca' }),
      h('div', { class: 'small', text: r.verificacion ? fmtDate(r.verificacion.verificadoEn) : '' })));

  const kpi = (label, value, sub, extra) => card({ class: 'kpi' }, h('div', { class: 'label', text: label }), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null, extra);
  const sellado = r.sellado.estado === 'activo' ? badge('b-good', 'Activo', 'check') : r.sellado.estado === 'detenido' ? badge('b-critica', 'Detenido', 'octagon') : badge('b-neutral', 'Sin datos', 'dash');
  const kpis = h('div', { class: 'grid kpis section' },
    kpi('Bloques sellados', fmtNum(r.cadena?.bloques ?? 0), r.cadena ? `Cabeza: bloque #${fmtNum(r.cadena.cabeza.index)}` : 'Cadena vacía'),
    kpi('Registros verificados', fmtNum(r.verificacion?.entradas), r.verificacion ? (r.verificacion.valida ? 'Firmas, enlaces y Merkle válidos' : `${fmtNum(r.verificacion.errores)} errores detectados`) : ''),
    kpi('Anomalías abiertas', fmtNum(r.alertas.abiertas), r.alertas.abiertasCriticas ? `${r.alertas.abiertasCriticas} críticas` : `${fmtNum(r.alertas.ultimos30Dias)} detectadas en 30 días`),
    kpi('Cambios por sellar', fmtNum(r.sellado.pendientes), r.sellado.pendientes ? `El más antiguo: hace ${r.sellado.pendienteMasAntiguoMin} min` : 'Todo está sellado'),
    kpi('Servicio de sellado', sellado, `Último latido ${relTime(r.sellado.ultimoLatido)}`),
  );

  const recent = alertas.slice(0, 6);
  const alertCard = card({},
    cardHead('Anomalías recientes', 'Folios públicos; el detalle completo es reservado.', h('a', { href: '#/anomalias', class: 'btn small' }, 'Ver todas')),
    recent.length ? alertList(recent) : emptyOk('No se han registrado anomalías.'));

  const head = r.cadena?.cabeza;
  const headCard = head ? card({ class: 'section' },
    cardHead('Cabeza de la cadena', 'El último bloque sellado. Cualquier persona puede compararlo con las copias de auditores y el anclaje externo.',
      h('a', { href: `#/bloques/${head.index}`, class: 'btn small' }, 'Ver bloque')),
    facts([
      ['Bloque', `#${fmtNum(head.index)}`], ['Sellado', fmtDate(head.timestamp)], ['Registros', fmtNum(head.entryCount)],
      ['Hash del bloque', mono(head.hash)], ['Bloque anterior', mono(head.prevHash)], ['Raíz de Merkle', mono(head.merkleRoot)], ['Llave de firma', mono(head.keyId)],
    ])) : null;

  root.replaceChildren(
    hero,
    kpis,
    h('div', { class: 'grid two section' }, activityCard(act), alertCard),
    headCard,
  );
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!document.hidden && (location.hash || '#/panorama').startsWith('#/panorama')) viewPanorama().catch(() => {}); }, 60_000);
}

function emptyOk(text) {
  return h('div', { class: 'empty' }, icon('shieldCheck'), text);
}

function alertList(items) {
  return h('ul', { class: 'alert-list' }, items.map((a) => h('li', {},
    h('a', { class: 'alert-item', href: `#/anomalias/${a.id ?? a.folio}` },
      h('div', {},
        h('div', { class: 't', text: a.titulo }),
        h('div', { class: 'm' },
          h('span', { class: 'mono', text: a.folio }),
          h('span', { text: fmtDay(a.detectadaEl) }),
          h('span', { text: ALCANCE[a.alcance] ?? a.alcance }),
          a.denunciaId ? h('span', { class: 'chip priv' }, icon('lock'), `Denuncia ${a.denunciaId}`) : null,
          a.bloque !== null && a.bloque !== undefined && a.alcance === 'cadena' ? h('span', { text: `Bloque #${a.bloque}` }) : null)),
      h('div', { class: 'r' }, sevBadge(a.severidad), estBadge(a.estado))))));
}

// ---- gráfica de actividad (barras apiladas, una escala, con tabla equivalente)
const SERIES = [['altas', 'Altas', '--series-1'], ['modificaciones', 'Modificaciones', '--series-2'], ['bajas', 'Bajas', '--series-3']];
function activityCard(act) {
  const u = act.umbralSupresion;
  const wrap = h('div', {});
  let asTable = false;
  const btn = h('button', { class: 'btn small toggle-table', type: 'button', 'aria-pressed': 'false' }, 'Ver tabla');
  btn.addEventListener('click', () => {
    asTable = !asTable;
    btn.textContent = asTable ? 'Ver gráfica' : 'Ver tabla';
    btn.setAttribute('aria-pressed', String(asTable));
    draw();
  });
  const draw = () => wrap.replaceChildren(asTable ? activityTable(act.dias, u) : activityChart(act.dias, u));
  draw();
  return card({},
    cardHead('Registros sellados · últimos 30 días', 'Altas, modificaciones y bajas de denuncias selladas por día (UTC).', btn),
    wrap,
    h('div', { class: 'legend' },
      SERIES.map(([, label, v]) => h('span', {}, h('span', { class: 'sw', style: `background:var(${v})` }), label)),
      h('span', {}, h('span', { class: 'sw supp' }), `Día con algún conteo menor a ${u} (suprimido)`)));
}
function activityTable(dias, u) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', { text: 'Día' }), SERIES.map(([, l]) => h('th', { class: 'num', text: l })), h('th', { class: 'num', text: 'Por conciliación' }), h('th', { class: 'num', text: 'Bloques' }))),
    h('tbody', {}, [...dias].reverse().map((d) => h('tr', {},
      h('td', { text: fmtDay(d.dia) }), SERIES.map(([k]) => h('td', { class: 'num', text: fmtSupp(d[k], u) })),
      h('td', { class: 'num', text: fmtSupp(d.porConciliacion, u) }), h('td', { class: 'num', text: fmtNum(d.bloques) }))))));
}
function activityChart(dias, u) {
  const W = 720; const H = 230; const M = { l: 40, r: 6, t: 10, b: 26 };
  const iw = W - M.l - M.r; const ih = H - M.t - M.b;
  const tot = (d) => SERIES.reduce((a, [k]) => a + (d[k] ?? 0), 0);
  const max = Math.max(4, ...dias.map(tot));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = (v) => M.t + ih - (v / top) * ih;
  const band = iw / dias.length; const bw = Math.max(4, Math.min(18, band * 0.62));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Gráfica de barras apiladas de registros sellados por día; use «Ver tabla» para los valores.' });
  for (let v = 0; v <= top; v += step) {
    svg.append(s('line', { class: 'grid-line', x1: M.l, x2: W - M.r, y1: y(v), y2: y(v) }));
    svg.append(s('text', { class: 'axis-text', x: M.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, document.createTextNode(nf.format(v))));
  }
  dias.forEach((d, i) => {
    const cx = M.l + band * i + band / 2;
    const g = s('g', { class: 'col' });
    let base = y(0);
    const segs = SERIES.map(([k, , v]) => [d[k] ?? 0, v]).filter(([n]) => n > 0);
    segs.forEach(([n, v], j) => {
      const hgt = (n / top) * ih;
      const yTop = base - hgt;
      const gap = j > 0 ? 2 : 0; // separación de 2px entre segmentos
      const isTop = j === segs.length - 1;
      const r = Math.min(4, hgt / 2, bw / 2);
      const x0 = cx - bw / 2; const x1 = cx + bw / 2; const yb = base - gap;
      const path = isTop && hgt - gap > r
        ? `M${x0},${yb}V${yTop + r}Q${x0},${yTop} ${x0 + r},${yTop}H${x1 - r}Q${x1},${yTop} ${x1},${yTop + r}V${yb}Z`
        : `M${x0},${yb}V${yTop}H${x1}V${yb}Z`;
      if (hgt - gap > 0.5) g.append(s('path', { d: path, style: `fill:var(${v})` }));
      base = yTop;
    });
    const suprimido = SERIES.some(([k]) => d[k] === null);
    if (suprimido) g.append(s('rect', { class: 'supp', x: cx - bw / 2 + 0.6, y: base - 9, width: bw - 1.2, height: 8, rx: 2 }));
    if (i % 5 === (dias.length - 1) % 5) {
      svg.append(s('text', { class: 'axis-text', x: cx, y: H - 8, 'text-anchor': 'middle' }, document.createTextNode(dayShort.format(new Date(`${d.dia}T12:00:00Z`)))));
    }
    const hit = s('rect', { class: 'hit', x: M.l + band * i, y: M.t, width: band, height: ih });
    const content = () => [
      h('div', {}, h('strong', { text: fmtDay(d.dia) })),
      ...SERIES.map(([k, l, v]) => h('div', { class: 'tt-row' }, h('span', {}, h('span', { class: 'sw', style: `background:var(${v})` }), l), h('span', { text: fmtSupp(d[k], u) }))),
      h('div', { class: 'tt-row' }, h('span', { text: 'Por conciliación' }), h('span', { text: fmtSupp(d.porConciliacion, u) })),
      h('div', { class: 'tt-row' }, h('span', { text: 'Bloques sellados' }), h('span', { text: fmtNum(d.bloques) })),
    ];
    hit.addEventListener('mousemove', (ev) => showTip(ev, content()));
    hit.addEventListener('mouseleave', hideTip);
    svg.append(g, hit);
  });
  svg.append(s('line', { x1: M.l, x2: W - M.r, y1: y(0), y2: y(0), style: 'stroke:var(--line-strong)' }));
  return h('div', { class: 'chart' }, svg);
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= raw) ?? 10 * p;
}

// ---- bloques
let blocksCache = [];
async function viewBloques(param) {
  const root = main();
  if (!blocksCache.length || param === 'recargar') blocksCache = await api('/publico/bloques');
  const sel = param !== undefined && param !== 'recargar' ? Number(param) : blocksCache[0]?.index;
  if (Number.isSafeInteger(sel) && !blocksCache.some((b) => b.index === sel) && sel >= 0) {
    // Carga páginas hasta encontrar el bloque solicitado (máx. 20 páginas).
    for (let i = 0; i < 20 && !blocksCache.some((b) => b.index === sel) && blocksCache.at(-1)?.index > 0; i += 1) {
      blocksCache.push(...await api(`/publico/bloques?antesDe=${blocksCache.at(-1).index}`));
    }
  }
  const byIndex = new Map(blocksCache.map((b) => [b.index, b]));
  const linkOk = (b) => (byIndex.has(b.index - 1) ? b.prevHash === byIndex.get(b.index - 1).hash : null);
  const u = catalogo.umbralSupresion;
  const asc = [...blocksCache].reverse();

  const strip = h('div', { class: 'chainviz', 'aria-label': 'Secuencia de bloques cargados' },
    asc.flatMap((b, i) => [
      i ? h('span', { class: 'lnk', 'aria-hidden': 'true' }) : null,
      h('a', { class: `blk ${b.index === sel ? 'sel' : ''} ${linkOk(b) === false ? 'bad' : ''}`, href: `#/bloques/${b.index}`, title: shortHash(b.hash) },
        h('strong', { text: `#${b.index}` }), `${fmtNum(b.entryCount)} reg.`),
    ]));

  const table = h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Bloque', 'Sellado', 'Registros', 'Altas', 'Modif.', 'Bajas', 'Hash', 'Enlace'].map((t, i) => h('th', { class: i >= 2 && i <= 5 ? 'num' : null, text: t })))),
    h('tbody', {}, blocksCache.map((b) => {
      const ok = linkOk(b);
      return h('tr', { class: `clickable ${b.index === sel ? 'selected' : ''}`, onclick: () => { location.hash = `#/bloques/${b.index}`; } },
        h('td', {}, h('a', { href: `#/bloques/${b.index}`, text: `#${b.index}` })), h('td', { text: fmtDate(b.timestamp) }),
        h('td', { class: 'num', text: fmtNum(b.entryCount) }), h('td', { class: 'num', text: fmtSupp(b.operaciones.alta, u) }),
        h('td', { class: 'num', text: fmtSupp(b.operaciones.modificacion, u) }), h('td', { class: 'num', text: fmtSupp(b.operaciones.baja, u) }),
        h('td', { class: 'hashcell', text: shortHash(b.hash) }),
        h('td', {}, ok === null ? h('span', { class: 'muted small', text: b.index === 0 ? 'Génesis' : '—' }) : ok ? badge('b-good', 'Enlazado', 'check') : badge('b-critica', 'Roto', 'octagon')));
    }))));

  const more = blocksCache.at(-1)?.index > 0
    ? h('button', { class: 'btn small', type: 'button', onclick: async (ev) => { ev.target.disabled = true; blocksCache.push(...await api(`/publico/bloques?antesDe=${blocksCache.at(-1).index}`)); viewBloques(String(sel)); } }, 'Cargar bloques anteriores')
    : null;

  const b = byIndex.get(sel);
  const detail = b ? card({ class: 'drawer' },
    cardHead(`Bloque #${b.index}`, b.index === 0 ? 'Bloque génesis: inicio de la cadena.' : `Sellado ${relTime(b.timestamp)}`),
    facts([
      ['Sellado', fmtDate(b.timestamp)], ['Registros', fmtNum(b.entryCount)], ['Versión', String(b.version)],
      ['Hash', mono(b.hash)], ['Bloque anterior', mono(b.prevHash)], ['Raíz de Merkle', mono(b.merkleRoot)],
      ['Llave', mono(b.keyId)], ['Firma Ed25519', mono(shortHash(b.signature))],
    ]),
    h('p', { class: 'small muted', style: 'margin:14px 0 0' },
      'El enlace se comprueba en su navegador comparando el «bloque anterior» con el hash del bloque previo. ',
      'La verificación completa (firmas y raíces de Merkle) la ejecuta el servicio periódicamente y puede reproducirse de forma independiente con la herramienta de verificación.'))
    : card({}, h('p', { class: 'muted', text: 'Seleccione un bloque.' }));

  root.replaceChildren(
    pageHead('Bloques de la cadena', 'Cada bloque agrupa huellas de cambios y está firmado y enlazado con el anterior. Los bloques no contienen datos de las denuncias.',
      h('a', { class: 'btn small', href: '#/bloques/recargar' }, icon('refresh'), 'Actualizar')),
    card({}, strip),
    h('div', { class: 'detail section' }, card({}, table, more ? h('div', { style: 'margin-top:12px' }, more) : null), detail),
  );
}

// ---- anomalías
const filtros = { severidad: 'todas', estado: 'abiertas' };
async function viewAnomalias(param) {
  if (param) return viewAnomalia(param);
  const root = main();
  root.replaceChildren(loading());
  const base = isPriv() ? '/privado/alertas' : '/publico/alertas';
  let pagina = 1;
  let items = await api(`${base}?pagina=1`);
  let done = items.length < 20;
  const listBox = h('div', {});
  const moreBox = h('div', { style: 'margin-top:12px' });

  const renderList = () => {
    const vis = items.filter((a) => (filtros.severidad === 'todas' || a.severidad === filtros.severidad)
      && (filtros.estado === 'todas' || ['abierta', 'en_revision'].includes(a.estado)));
    listBox.replaceChildren(vis.length ? alertList(vis) : emptyOk(filtros.estado === 'abiertas' ? 'No hay anomalías abiertas con este filtro.' : 'No hay anomalías con este filtro.'));
    moreBox.replaceChildren(done ? '' : h('button', {
      class: 'btn small', type: 'button',
      onclick: async (ev) => {
        ev.target.disabled = true;
        pagina += 1;
        const next = await api(`${base}?pagina=${pagina}`);
        items = items.concat(next);
        done = next.length < 20;
        renderList();
      },
    }, 'Cargar más'));
  };
  const filterGroup = (key, opts) => h('div', { class: 'filters', role: 'group' }, opts.map(([v, l]) => h('button', {
    type: 'button', 'aria-pressed': String(filtros[key] === v),
    onclick: (ev) => { filtros[key] = v; ev.target.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === ev.target))); renderList(); },
  }, l)));

  root.replaceChildren(
    pageHead('Anomalías de integridad', isPriv()
      ? 'Vista completa: incluye la denuncia afectada, la evidencia técnica y el seguimiento.'
      : 'Cada anomalía tiene un folio público aleatorio que no permite identificar la denuncia relacionada.'),
    card({},
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
        filterGroup('estado', [['abiertas', 'Abiertas y en revisión'], ['todas', 'Todas']]),
        filterGroup('severidad', [['todas', 'Toda severidad'], ['critica', 'Crítica'], ['alta', 'Alta'], ['media', 'Media'], ['baja', 'Baja']])),
      listBox, moreBox),
    card({ class: 'section' }, cardHead('Tipos de anomalía', 'Qué vigila el sistema y qué significa cada alerta.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Tipo' }), h('th', { text: 'Severidad' }), h('th', { text: 'Descripción' }))),
        h('tbody', {}, catalogo.tipos.map((t) => h('tr', {}, h('td', { text: t.titulo }), h('td', {}, sevBadge(t.severidad)), h('td', { class: 'muted', text: t.descripcion }))))))),
  );
  renderList();
}

async function viewAnomalia(ref) {
  const root = main();
  root.replaceChildren(loading());
  const a = isPriv() ? await api(`/privado/alertas/${encodeURIComponent(ref)}`) : await api(`/publico/alertas/${encodeURIComponent(ref)}`);
  const back = h('a', { href: '#/anomalias', class: 'btn small ghost' }, '← Anomalías');

  const main1 = card({},
    h('div', { class: 'row', style: 'gap:8px;margin-bottom:10px' }, sevBadge(a.severidad), estBadge(a.estado)),
    h('h1', { text: a.titulo }),
    h('p', { class: 'muted', style: 'margin:6px 0 16px;max-width:70ch', text: a.resumen }),
    facts([
      ['Folio', mono(a.folio)], ['Detectada', isPriv() ? fmtDate(a.detectadaEn) : fmtDay(a.detectadaEl)],
      ['Alcance', ALCANCE[a.alcance] ?? a.alcance],
      a.bloque !== null && a.bloque !== undefined ? ['Bloque', h('a', { href: `#/bloques/${a.bloque}`, text: `#${a.bloque}` })] : null,
      ['Estado', EST[a.estado]?.[0] ?? a.estado],
    ]),
    isPriv() ? null : h('p', { class: 'small muted', style: 'margin:16px 0 0' },
      'Por protección de datos personales, la versión pública no incluye el número de la denuncia, las huellas de los documentos, ',
      'la hora exacta ni las notas de la investigación. Esa información está disponible solo para la Contraloría interna y la Administración.'));

  const sections = [main1];
  if (isPriv()) sections.push(...reservedSections(a));

  const tl = card({},
    cardHead('Cronología'),
    h('ol', { class: 'timeline' },
      h('li', {}, h('strong', { text: 'Detectada' }), h('div', { class: 'small muted', text: isPriv() ? `${fmtDate(a.detectadaEn)} · ${ORIGEN[a.origen] ?? a.origen}` : fmtDay(a.detectadaEl) })),
      a.cronologia.map((c) => h('li', {},
        estBadge(c.estado),
        h('div', { class: 'small muted', style: 'margin-top:4px', text: isPriv() ? `${fmtDate(c.en)} · ${c.usuario} (${ROL[c.rol] ?? c.rol})` : fmtDay(c.fecha) }),
        isPriv() && c.nota ? h('div', { class: 'note', text: c.nota }) : null))));
  const side = [tl];
  if (isPriv()) side.push(seguimientoForm(a));

  root.replaceChildren(
    h('div', { style: 'margin-bottom:10px' }, back),
    h('div', { class: 'detail' }, h('div', { class: 'stack' }, sections), h('div', { class: 'stack' }, side)),
  );
}

function integridadCheck(ia) {
  if (!ia) return null;
  if (!ia.disponible) return h('div', { class: 'check warn' }, icon('info'), h('span', { text: ia.mensaje }));
  if (ia.integra === true) return h('div', { class: 'check ok' }, icon('shieldCheck'), h('span', {}, h('strong', { text: 'El documento vigente coincide con la cadena. ' }), `Versión ${ia.version}, bloque #${ia.bloque}, sellada el ${fmtDate(ia.selladoEn)}`));
  if (ia.integra === false) {
    const pend = /pendiente/i.test(ia.mensaje);
    return h('div', { class: `check ${pend ? 'warn' : 'bad'}` }, icon(pend ? 'clock' : 'octagon'), h('span', {}, h('strong', { text: `${ia.mensaje}. ` }),
      h('br'), 'Vigente: ', mono(ia.hashActual), h('br'), 'Sellada: ', mono(ia.ultimoHashSellado)));
  }
  return h('div', { class: 'check warn' }, icon('info'), h('span', { text: ia.mensaje }));
}

function historialTable(hist) {
  const rows = [
    ...hist.selladas.map((e) => ({ ...e, sellada: true })),
    ...hist.pendientes.map((e) => ({ ...e, sellada: false })),
  ];
  if (!rows.length) return h('p', { class: 'muted', text: 'Sin registros en la cadena.' });
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Versión', 'Operación', 'Origen', 'Observada', 'Bloque', 'Huella'].map((t) => h('th', { text: t })))),
    h('tbody', {}, rows.map((e) => h('tr', {},
      h('td', { text: `v${e.version}` }), h('td', { text: OPS[e.operacion] ?? e.operacion }),
      h('td', {}, e.origen === 'conciliacion' ? badge('b-alta', 'Conciliación', 'alert') : ORIGEN[e.origen] ?? e.origen),
      h('td', { text: fmtDate(e.observadoEn) }),
      h('td', {}, e.sellada ? h('a', { href: `#/bloques/${e.bloque}`, text: `#${e.bloque}` }) : badge('b-media', 'Pendiente', 'clock')),
      h('td', { class: 'hashcell', title: e.hashDocumento ?? 'sin documento (baja)', text: e.hashDocumento ? shortHash(e.hashDocumento) : '— (baja)' }))))));
}

function detalleValue(k, v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (Array.isArray(v)) return h('ul', { class: 'errors' }, v.slice(0, 50).map((x) => h('li', { text: String(x) })));
  if (typeof v === 'object') return mono(JSON.stringify(v));
  if (k === 'operacion') return OPS[v] ?? v;
  if (/^[0-9a-f]{64}$/.test(String(v))) return mono(v);
  return String(v);
}

function reservedSections(a) {
  const out = [];
  out.push(card({ class: 'reserved' },
    cardHead('Evidencia reservada', 'Solo visible para Contraloría interna y Administración.', reservedTag()),
    facts([
      a.denunciaId ? ['Denuncia', h('a', { href: `#/denuncia/${encodeURIComponent(a.denunciaId)}` }, mono(a.denunciaId))] : null,
      ['Detectada por', ORIGEN[a.origen] ?? a.origen],
      ...Object.entries(a.detalle ?? {}).map(([k, v]) => [DETALLE[k] ?? k, detalleValue(k, v)]),
    ])));
  const ctx = a.contexto ?? {};
  if (ctx.integridadActual || ctx.historial) {
    out.push(card({ class: 'reserved' },
      cardHead('Estado actual de la denuncia', 'Comparación en vivo del documento del S5 contra la cadena e historial sellado.', reservedTag()),
      h('div', { class: 'stack' }, integridadCheck(ctx.integridadActual), ctx.historial ? historialTable(ctx.historial) : null)));
  }
  if (ctx.bloque) {
    const errs = ctx.bloque.erroresActuales ?? [];
    out.push(card({ class: 'reserved' },
      cardHead(`Revisión del bloque #${a.bloque}`, 'Resultado de volver a verificar el bloque en este momento.', reservedTag()),
      errs.length
        ? h('div', { class: 'check bad' }, icon('octagon'), h('span', {}, h('strong', { text: `${errs.length} problema(s) vigente(s):` }), h('ul', { class: 'errors' }, errs.map((x) => h('li', { text: x })))))
        : h('div', { class: 'check ok' }, icon('shieldCheck'), h('span', { text: 'El bloque verifica correctamente en este momento (firma, hash, Merkle y enlace).' }))));
  }
  return out;
}

function seguimientoForm(a) {
  const msg = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const opts = Object.entries(EST).filter(([k]) => k !== a.estado);
  const form = h('form', { class: 'stack', novalidate: true },
    h('label', {}, 'Nuevo estado', h('select', { name: 'estado' }, opts.map(([k, [l]]) => h('option', { value: k, text: l })))),
    h('label', {}, 'Nota (obligatoria)', h('textarea', { name: 'nota', maxlength: '2000', minlength: '10', required: true, placeholder: 'Acciones realizadas, oficio, responsable o conclusión…' })),
    msg,
    h('button', { class: 'btn primary', type: 'submit' }, 'Registrar seguimiento'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api(`/privado/alertas/${a.id}/seguimiento`, { method: 'POST', body: { estado: f.get('estado'), nota: f.get('nota') } });
      viewAnomalia(a.id);
    } catch (e) {
      msg.textContent = e.message;
      msg.hidden = false;
      btn.disabled = false;
    }
  });
  return card({ class: 'reserved' }, cardHead('Seguimiento', 'Queda registrado con su usuario; no puede editarse ni borrarse.', reservedTag()), form);
}

// ---- consulta de denuncia (privado)
async function viewDenuncia(param) {
  if (!isPriv()) return denied();
  const root = main();
  const input = h('input', { name: 'id', value: param ? decodeURIComponent(param) : '', placeholder: 'Identificador de la denuncia en el S5', spellcheck: 'false', autocomplete: 'off', maxlength: '128' });
  const out = h('div', { class: 'section' });
  const form = h('form', { class: 'row' }, h('label', {}, 'Identificador', input), h('button', { class: 'btn primary', type: 'submit' }, icon('search'), 'Consultar'));
  form.addEventListener('submit', (ev) => { ev.preventDefault(); const v = input.value.trim(); if (v) location.hash = `#/denuncia/${encodeURIComponent(v)}`; });
  root.replaceChildren(
    pageHead('Consulta de denuncia', 'Compara el documento vigente en el S5 con su última huella sellada y muestra su historial de versiones. La consulta queda registrada en la bitácora.'),
    card({ class: 'reserved' }, h('div', { class: 'card-head' }, h('span'), reservedTag()), form),
    out);
  if (!param) return;
  out.replaceChildren(loading());
  try {
    const r = await api(`/privado/denuncias/${param}`);
    out.replaceChildren(card({ class: 'reserved' },
      cardHead(`Denuncia ${r.historial.denunciaId}`, `${r.historial.selladas.length} versiones selladas · ${r.historial.pendientes.length} pendientes`),
      h('div', { class: 'stack' }, integridadCheck(r.integridadActual), historialTable(r.historial))));
  } catch (e) {
    out.replaceChildren(errorBox(e));
  }
}

// ---- bitácora (administrador)
async function viewBitacora() {
  if (!isAdmin()) return denied();
  const root = main();
  root.replaceChildren(loading());
  let pagina = 1;
  let rows = await api('/admin/bitacora?pagina=1');
  const tbody = h('tbody');
  const more = h('div', { style: 'margin-top:12px' });
  const render = (done) => {
    tbody.replaceChildren(...rows.map((l) => h('tr', {},
      h('td', { text: fmtDate(l.en) }), h('td', { text: l.usuario ?? '—' }), h('td', { text: ROL[l.rol] ?? '—' }),
      h('td', { text: ACCION[l.accion] ?? l.accion }), h('td', { class: 'small', text: l.objeto ?? '' }),
      h('td', {}, l.resultado === 'ok' || l.resultado === 'valida' ? badge('b-good', 'Correcto', 'check') : badge('b-alta', l.resultado.replaceAll('_', ' '), 'alert')),
      h('td', { class: 'hashcell', text: l.ip ?? '' }))));
    more.replaceChildren(done ? '' : h('button', { class: 'btn small', type: 'button', onclick: async () => { pagina += 1; const n = await api(`/admin/bitacora?pagina=${pagina}`); rows = rows.concat(n); render(n.length < 50); } }, 'Cargar más'));
  };
  render(rows.length < 50);
  root.replaceChildren(
    pageHead('Bitácora de accesos', 'Registro inalterable de inicios de sesión y de cada consulta a información reservada. La propia consulta de esta bitácora también queda registrada.'),
    card({}, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Fecha', 'Usuario', 'Rol', 'Acción', 'Objeto', 'Resultado', 'IP'].map((t) => h('th', { text: t })))), tbody)), more));
}

// ---- operación (administrador)
async function viewOperacion() {
  if (!isAdmin()) return denied();
  const root = main();
  root.replaceChildren(loading());
  const op = await api('/admin/operacion');
  const result = h('div', { class: 'section' });
  const btn = h('button', { class: 'btn primary', type: 'button' }, icon('shieldCheck'), 'Verificar la cadena ahora');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    result.replaceChildren(h('p', { class: 'muted', text: 'Verificando todos los bloques…' }));
    let r;
    try { r = await api('/admin/verificar', { method: 'POST' }); } catch (e) { r = e.data; if (!r?.bloques) { result.replaceChildren(errorBox(e)); btn.disabled = false; return; } }
    result.replaceChildren(r.valida
      ? h('div', { class: 'check ok' }, icon('shieldCheck'), h('span', { text: `Cadena íntegra: ${fmtNum(r.bloques)} bloques y ${fmtNum(r.entradas)} registros verificados (${fmtDate(r.verificadoEn)}).` }))
      : h('div', { class: 'check bad' }, icon('octagon'), h('span', {}, h('strong', { text: `Cadena NO íntegra: ${r.errores.length} errores. Se registró una anomalía crítica.` }), h('ul', { class: 'errors' }, r.errores.slice(0, 30).map((x) => h('li', { text: x }))))));
    btn.disabled = false;
  });
  const v = op.verificacion; const c = op.conciliacion; const l = op.latido;
  root.replaceChildren(
    pageHead('Estado operativo', 'Salud del servicio de sellado y de las tareas de verificación.', btn),
    result,
    h('div', { class: 'grid kpis section' },
      card({ class: 'kpi' }, h('div', { class: 'label', text: 'Último latido del sellado' }), h('div', { class: 'value', text: relTime(l?.en) }), h('div', { class: 'sub', text: l ? `Intervalo ${Math.round(l.intervaloMs / 1000)} s` : '' })),
      card({ class: 'kpi' }, h('div', { class: 'label', text: 'Última verificación integral' }), h('div', { class: 'value', text: relTime(v?.verificadoEn) }), h('div', { class: 'sub', text: v ? (v.valida ? 'Válida' : `${v.errores} errores`) : '' })),
      card({ class: 'kpi' }, h('div', { class: 'label', text: 'Última conciliación con el S5' }), h('div', { class: 'value', text: relTime(c?.en) }), h('div', { class: 'sub', text: c ? `${fmtNum(c.denuncias)} denuncias · ${fmtNum(c.cambios)} cambios · ${fmtNum(c.ms)} ms` : '' })),
      card({ class: 'kpi' }, h('div', { class: 'label', text: 'Cambios pendientes de sellar' }), h('div', { class: 'value', text: fmtNum(op.pendientes) }), h('div', { class: 'sub', text: op.pendienteMasAntiguo ? `Desde ${fmtDate(op.pendienteMasAntiguo)}` : 'Ninguno' }))),
    card({ class: 'section' }, cardHead('Configuración de confianza'),
      facts([
        ['Llaves de firma de confianza', h('div', {}, op.llavesDeConfianza.map((k) => h('div', {}, mono(k))))],
        ['Acceso del panel al S5', op.accesoS5DesdePanel ? 'Sí (lectura) — permite comparar documentos vigentes' : 'No — la comparación en vivo se consulta en la API interna'],
      ])));
}

function denied() {
  main().replaceChildren(card({}, h('div', { class: 'empty' }, icon('lock'), h('p', { text: 'Esta sección requiere acceso de Contraloría interna o Administración.' }),
    h('button', { class: 'btn primary', type: 'button', onclick: openLogin }, 'Iniciar sesión'))));
}

// ---------------------------------------------------------------- enrutador
const ROUTES = { panorama: viewPanorama, bloques: viewBloques, anomalias: viewAnomalias, denuncia: viewDenuncia, bitacora: viewBitacora, operacion: viewOperacion };
async function route() {
  clearInterval(refreshTimer);
  hideTip();
  const [, name = 'panorama', ...rest] = (location.hash || '#/panorama').split('/');
  const view = ROUTES[name] ?? viewPanorama;
  renderChrome();
  try {
    await view(rest.length ? rest.join('/') : undefined);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return denied();
    main().replaceChildren(errorBox(e));
  }
  if (!rest.length) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

(async function init() {
  [session, catalogo] = await Promise.all([api('/sesion').catch(() => ({ rol: 'publico' })), api('/publico/catalogo').catch(() => catalogo)]);
  $('#umbral').textContent = catalogo.umbralSupresion;
  $('#umbral2').textContent = catalogo.umbralSupresion;
  if (isPriv()) armIdle();
  route();
}());

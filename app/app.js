// Simulador 7M · carga de datos: lee los ficheros de datos/ (actualizados cada semana) y avisa a la página para que se pinte.
window.dash = (function () {
  const IDS = ['empresas', 'trayectorias', 'multiplos', 'modelo', 'parametros', 'historico', 'estado'];
  const store = {}, subs = [];
  let pendiente = false, ancho = 0;
  IDS.forEach((id) => (store[id] = { status: 'loading', data: [] }));
  const avisar = () => {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(() => { pendiente = false; subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); });
  };
  async function cargar() {
    await Promise.all(IDS.map(async (id) => {
      try {
        const r = await fetch(`datos/${id}.json`, { cache: 'no-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        store[id] = { status: 'ok', data: await r.json() };
      } catch (e) { store[id] = { status: 'error', data: [], message: String(e) }; }
    }));
    avisar();
  }
  window.addEventListener('resize', () => { const w = document.documentElement.clientWidth; if (w !== ancho) { ancho = w; avisar(); } });
  return { data: (id) => store[id] || { status: 'missing', data: [] }, onData: (fn) => { subs.push(fn); fn(); }, colors: ['var(--s1)', 'var(--s2)', 'var(--s3)'], cargar, avisar };
})();


(function () {
  const IDS = ['empresas', 'trayectorias', 'multiplos', 'modelo', 'parametros'];
  const OPC = ['historico', 'estado'];
  const ESC = ['pes', 'base', 'opt'];
  const NOM_ESC = { pes: 'Pesimista', base: 'Base', opt: 'Optimista' };
  const $ = (s) => document.querySelector(s);

  // ---------------------------------------------------------------- formato
  const nfCache = {};
  const nf = (d) => nfCache[d] || (nfCache[d] = new Intl.NumberFormat('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' }));
  const num = (x, d = 0, signo = false) => {
    if (x == null || !isFinite(x)) return '—';
    const s = nf(d).format(Math.abs(x));
    return (x < 0 && Number(s.replace(/\./g, '').replace(',', '.')) !== 0 ? '−' : signo && x > 0 ? '+' : '') + s;
  };
  const pct = (x, d = 1, signo = false) => (x == null || !isFinite(x) ? '—' : num(x * 100, d, signo) + ' %');
  const pp = (x, d = 1) => (x == null || !isFinite(x) ? '—' : num(x * 100, d, true) + ' pp');
  const usd = (x, d = 0) => (x == null || !isFinite(x) ? '—' : num(x, d) + ' $');
  const mm = (x, d = 0) => num(x / 1000, d);
  const fecha = (s) => { const [a, m, d] = String(s).slice(0, 10).split('-'); return `${Number(d)}/${Number(m)}/${a}`; };
  const clsPot = (x) => (x >= 0 ? 'sv-pos' : 'sv-neg');

  // ---------------------------------------------------------------- datos y estado
  let D = null, S = null, DEF = null;

  function cargar() {
    const st = IDS.map((id) => dash.data(id));
    if (st.some((s) => s.status !== 'ok')) return null;
    const [emp, tr, mu, mo, pa] = st.map((s) => s.data);
    const N = (x) => Number(x);
    const empresas = emp.map((e) => {
      const o = Object.assign({}, e);
      for (const k of Object.keys(o)) if (!['ticker', 'empresa', 'nombre', 'fecha_balance'].includes(k)) o[k] = N(o[k]);
      return o;
    });
    const trays = {};
    for (const e of empresas) {
      trays[e.ticker] = {};
      for (const sc of ESC) {
        const rows = tr.filter((r) => r.ticker === e.ticker && r.escenario === sc).sort((a, b) => N(a.anio) - N(b.anio));
        trays[e.ticker][sc] = { gr: rows.map((r) => N(r.crecimiento)), mg: rows.map((r) => N(r.margen_ebit)), da: rows.map((r) => N(r.amortizacion_ventas)),
          cx: rows.map((r) => N(r.capex_ventas)), nf: rows.map((r) => N(r.nof_ventas)) };
      }
    }
    const porT = (rows) => Object.fromEntries(rows.map((r) => [r.ticker, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'ticker' || k === 'comparables' ? v : N(v)]))]));
    const p = pa[0];
    const op = (id, def) => { const s = dash.data(id); return s.status === 'ok' ? s.data : def; };
    return { emp: empresas, trays, mu: porT(mu), mo: porT(mo), pa: p, hist: op('historico', []), estado: op('estado', {}) };
  }

  function defectos(p) {
    return { rf: Number(p.tipo_sin_riesgo), erp: Number(p.prima_riesgo_mercado), spread: Number(p.diferencial_deuda), g: Number(p.crecimiento_perpetuo), dwacc: 0,
      prob: { pes: Number(p.prob_pesimista), base: Number(p.prob_base), opt: Number(p.prob_optimista) }, pesoDcf: Number(p.peso_dcf), roicTope: Number(p.roic_tope),
      fr: { pes: Number(p.convergencia_roic_pesimista), base: Number(p.convergencia_roic_base), opt: Number(p.convergencia_roic_optimista) }, metodoVt: 'inductores' };
  }
  const copia = (o) => JSON.parse(JSON.stringify(o));
  const ajDef = (e) => ({ beta: e.beta, dg: 0, dm: 0, invModo: 'consenso', ronic: null, lag: 1 });

  function iniciar() {
    DEF = defectos(D.pa);
    S = { par: copia(DEF), aj: {}, sel: null };
    for (const e of D.emp) S.aj[e.ticker] = ajDef(e);
    const v = calcular();
    S.sel = D.emp.slice().sort((a, b) => v[b.ticker].pot - v[a.ticker].pot)[0].ticker;
    montarControles();
  }

  function calcularDefecto() {
    const out = {};
    for (const e of D.emp) out[e.ticker] = MOTOR.valorar(e, D.trays[e.ticker], D.mu[e.ticker], DEF, ajDef(e));
    return out;
  }

  function calcular() {
    const out = {};
    for (const e of D.emp) out[e.ticker] = MOTOR.valorar(e, D.trays[e.ticker], D.mu[e.ticker], S.par, S.aj[e.ticker]);
    return out;
  }

  // ---------------------------------------------------------------- controles
  const CTRL = [
    { id: 'rf', get: () => S.par.rf, set: (x) => (S.par.rf = x), fmt: (x) => pct(x, 2), def: () => DEF.rf },
    { id: 'erp', get: () => S.par.erp, set: (x) => (S.par.erp = x), fmt: (x) => pct(x, 2), def: () => DEF.erp },
    { id: 'dw', get: () => S.par.dwacc, set: (x) => (S.par.dwacc = x), fmt: (x) => pp(x, 2), def: () => 0 },
    { id: 'g', get: () => S.par.g, set: (x) => (S.par.g = x), fmt: (x) => pct(x, 2), def: () => DEF.g },
    { id: 'pd', get: () => S.par.pesoDcf, set: (x) => (S.par.pesoDcf = x), fmt: (x) => `${pct(x, 0)} DCF · ${pct(1 - x, 0)} múltiplos`, def: () => DEF.pesoDcf },
  ];
  function probs(cual, x) {
    const p = S.par.prob;
    if (cual === 'pes') p.pes = x; else p.opt = x;
    if (p.pes + p.opt > 1) { if (cual === 'pes') p.opt = Math.round((1 - p.pes) * 100) / 100; else p.pes = Math.round((1 - p.opt) * 100) / 100; }
    p.base = Math.round((1 - p.pes - p.opt) * 100) / 100;
  }
  const PRESETS = [
    ['Tipos −1 pp', (p) => { p.rf = DEF.rf - 0.01; }],
    ['Tipos +1 pp', (p) => { p.rf = DEF.rf + 0.01; }],
    ['Prima de riesgo +1 pp', (p) => { p.erp = DEF.erp + 0.01; }],
    ['g del 2 %', (p) => { p.g = 0.02; }],
    ['Más peso al pesimista (50/40/10)', (p) => { p.prob = { pes: 0.5, base: 0.4, opt: 0.1 }; }],
    ['Solo DCF', (p) => { p.pesoDcf = 1; }],
    ['Solo múltiplos', (p) => { p.pesoDcf = 0; }],
    ['Valor terminal de Gordon', (p) => { p.metodoVt = 'gordon'; }],
  ];

  function montarControles() {
    for (const c of CTRL) {
      const el = $('#sv-' + c.id);
      el.addEventListener('input', () => { c.set(Number(el.value)); pintar(); });
    }
    $('#sv-pp').addEventListener('input', (ev) => { probs('pes', Number(ev.target.value)); pintar(); });
    $('#sv-po').addEventListener('input', (ev) => { probs('opt', Number(ev.target.value)); pintar(); });
    for (const b of document.querySelectorAll('#sv-vt button')) b.addEventListener('click', () => { S.par.metodoVt = b.dataset.vt; pintar(); });
    const pr = $('#sv-presets');
    PRESETS.forEach(([lab, fn]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sv-chip'; b.textContent = lab;
      b.addEventListener('click', () => { const p = copia(DEF); fn(p); S.par = p; pintar(); });
      pr.appendChild(b);
    });
    $('#sv-reset').addEventListener('click', () => {
      S.par = copia(DEF);
      for (const e of D.emp) S.aj[e.ticker] = ajDef(e);
      pintar();
    });
    const emps = $('#sv-emps');
    for (const e of D.emp) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sv-chip'; b.dataset.t = e.ticker;
      const n = document.createElement('span'); n.textContent = e.nombre;
      const p = document.createElement('span'); p.className = 'sv-chip-p';
      b.append(n, p);
      b.addEventListener('click', () => { S.sel = e.ticker; pintar(); });
      emps.appendChild(b);
    }
    $('#sv-beta').addEventListener('input', (ev) => { S.aj[S.sel].beta = Number(ev.target.value); pintar(); });
    $('#sv-dg').addEventListener('input', (ev) => { S.aj[S.sel].dg = Number(ev.target.value); pintar(); });
    $('#sv-dm').addEventListener('input', (ev) => { S.aj[S.sel].dm = Number(ev.target.value); pintar(); });
    $('#sv-aj-reset').addEventListener('click', () => { const e = D.emp.find((x) => x.ticker === S.sel); S.aj[S.sel] = ajDef(e); pintar(); });
    for (const b of document.querySelectorAll('#sv-inv button')) b.addEventListener('click', () => {
      const aj = S.aj[S.sel];
      if (b.dataset.m === 'explicito') {
        const e = D.emp.find((x) => x.ticker === S.sel);
        const r = MOTOR.valorar(e, D.trays[S.sel], D.mu[S.sel], S.par, Object.assign({}, aj, { invModo: 'consenso' })).ronicImpl;
        if (r == null) return;
        if (aj.ronic == null) aj.ronic = Math.round(r * 1000) / 1000;
        aj.invModo = 'explicito';
      } else aj.invModo = 'consenso';
      pintar();
    });
    $('#sv-ronic').addEventListener('input', (ev) => { S.aj[S.sel].ronic = Number(ev.target.value); pintar(); });
    $('#sv-lag').addEventListener('input', (ev) => { S.aj[S.sel].lag = Number(ev.target.value); pintar(); });
    $('#sv-tabla tbody').addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-key]');
      if (tr) { S.sel = tr.dataset.key; pintar(); }
    });
    for (const c of CTRL) { const el = $('#sv-' + c.id); el.style.accentColor = dash.colors[0]; }
    for (const id of ['pp', 'po', 'beta', 'dg', 'dm', 'ronic', 'lag']) $('#sv-' + id).style.accentColor = dash.colors[0];
  }

  function sincronizarControles() {
    for (const c of CTRL) {
      const el = $('#sv-' + c.id);
      if (document.activeElement !== el) el.value = c.get();
      $('#sv-' + c.id + '-v').textContent = c.fmt(c.get());
      const d = $('#sv-' + c.id + '-d'); if (d) d.textContent = 'Por defecto: ' + c.fmt(c.def());
    }
    const p = S.par.prob;
    $('#sv-pp').value = p.pes; $('#sv-po').value = p.opt;
    $('#sv-pp-v').textContent = pct(p.pes, 0); $('#sv-po-v').textContent = pct(p.opt, 0);
    $('#sv-prob-d').textContent = `Base: ${pct(p.base, 0)} · por defecto: ${pct(DEF.prob.pes, 0)} / ${pct(DEF.prob.base, 0)} / ${pct(DEF.prob.opt, 0)}`;
    for (const b of document.querySelectorAll('#sv-vt button')) b.setAttribute('aria-pressed', String(b.dataset.vt === S.par.metodoVt));
    $('#sv-vt-d').textContent = 'Por defecto: inductores (ROIC)';
    resumenSupuestos();
  }

  // ---------------------------------------------------------------- utilidades de gráficos
  const colorDe = (() => {
    let probe = null;
    return (css) => {
      if (!probe) { probe = document.createElement('span'); probe.style.display = 'none'; $('#simulador').appendChild(probe); }
      probe.style.color = ''; probe.style.color = css;
      return getComputedStyle(probe).color;
    };
  })();
  function lienzo(cont, alto) {
    const w = Math.max(280, cont.clientWidth);
    cont.replaceChildren();
    const svg = d3.select(cont).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${w} ${alto}`).attr('height', alto);
    const tip = d3.select(cont).append('div').attr('class', 'sv-tip').style('opacity', 0);
    return { svg, tip, w };
  }
  function medir(svg, textos, size = 12) {
    const t = svg.append('text').attr('font-size', size).attr('visibility', 'hidden');
    let m = 0;
    for (const s of textos) { t.text(s); m = Math.max(m, t.node().getComputedTextLength()); }
    t.remove();
    return m;
  }
  function moverTip(tip, cont, x, y) {
    const n = tip.node(), cw = cont.clientWidth, tw = n.offsetWidth;
    tip.style('left', Math.max(0, Math.min(cw - tw, x + 12)) + 'px').style('top', Math.max(0, y - 10) + 'px');
  }
  function linea(tip, filas) {
    const n = tip.node();
    n.replaceChildren();
    filas.forEach(([txt, color, cls]) => {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      if (color) { const s = document.createElement('span'); s.className = 'sv-tip-s'; s.style.background = color; div.appendChild(s); }
      div.appendChild(document.createTextNode(txt));
      n.appendChild(div);
    });
  }

  // ---------------------------------------------------------------- pintado
  function pintar() {
    if (!D) return;
    sincronizarControles();
    const V = calcular();
    pintarCabecera(V);
    pintarKpis(V);
    pintarPotencial(V);
    pintarTabla(V);
    pintarDetalle(V);
  }

  function pintarCabecera(V) {
    const pots = D.emp.filter((e) => V[e.ticker].valido).map((e) => V[e.ticker].pot);
    const n = pots.filter((x) => x > 0).length;
    const med = d3.median(pots);
    const Vd = calcularDefecto();
    const ref = D.emp.map((e) => Vd[e.ticker].pot);
    const cambiado = JSON.stringify(S.par) !== JSON.stringify(DEF) || D.emp.some((e) => S.aj[e.ticker].dg || S.aj[e.ticker].dm || S.aj[e.ticker].beta !== e.beta || S.aj[e.ticker].invModo === 'explicito');
    const take = $('#sv-take');
    take.classList.remove('dash-skeleton');
    take.textContent = `Con ${cambiado ? 'estos supuestos' : 'los supuestos por defecto'}, ${n} de ${D.emp.length} empresas cotizan por debajo de su valor central y el potencial mediano es del ${pct(med, 0, true)}` +
      (cambiado ? ` (por defecto: ${ref.filter((x) => x > 0).length} de ${D.emp.length} y ${pct(d3.median(ref), 0, true)}).` : '.');
    $('#sv-tope').textContent = pct(D.pa.roic_tope, 0);
    $('#sv-fv').textContent = fecha(D.pa.fecha_valoracion);
    const est = D.estado || {};
    $('#sv-meta').textContent = `Cotizaciones y consenso del ${fecha(est.fecha_mercado || D.pa.fecha_cotizacion)} · valoración completa del ${fecha(est.valoracion_completa || D.pa.fecha_valoracion)} · importes en dólares`;
    pintarEstado();
  }

  function pintarKpis(V) {
    const E = D.emp.filter((e) => V[e.ticker].valido), ref = D.emp.map((e) => D.mo[e.ticker].potencial);
    const pots = E.map((e) => V[e.ticker].pot);
    const set = (id, txt, cls) => { const el = $('#' + id); el.classList.remove('dash-skeleton', 'sv-pos', 'sv-neg'); if (cls) el.classList.add(cls); el.textContent = txt; };
    set('k1', `${pots.filter((x) => x > 0).length} de ${D.emp.length}`);
    $('#k1r').textContent = `Informe 10/10: ${ref.filter((x) => x > 0).length} de ${D.emp.length}`;
    const med = d3.median(pots);
    set('k2', pct(med, 0, true), clsPot(med));
    $('#k2r').textContent = `Informe 10/10: ${pct(d3.median(ref), 0, true)}`;
    const cap = d3.sum(E, (e) => e.cotizacion * e.acciones_m);
    const val = d3.sum(E, (e) => V[e.ticker].central * e.acciones_m);
    const valRef = d3.sum(E, (e) => D.mo[e.ticker].valor_central * e.acciones_m);
    const capRef = d3.sum(E, (e) => D.mo[e.ticker].valor_central / (1 + D.mo[e.ticker].potencial) * e.acciones_m);
    set('k3', pct(val / cap - 1, 0, true), clsPot(val / cap - 1));
    $('#k3r').textContent = `${num(val / 1e6, 1)} frente a ${num(cap / 1e6, 1)} billones de $ · informe 10/10: ${pct(valRef / capRef - 1, 0, true)}`;
    set('k4', pct(d3.mean(E, (e) => V[e.ticker].w), 1));
    $('#k4r').textContent = `Del ${pct(d3.min(E, (e) => V[e.ticker].w), 1)} al ${pct(d3.max(E, (e) => V[e.ticker].w), 1)} · informe 10/10: ${pct(d3.mean(E, (e) => D.mo[e.ticker].wacc), 1)}`;
  }

  function pintarPotencial(V) {
    const cont = $('#sv-pot');
    cont.classList.remove('dash-skeleton');
    const fuera = D.emp.filter((e) => !V[e.ticker].valido).map((e) => e.nombre);
    $('#sv-pot-x').textContent = fuera.length ? `Sin valor con estos supuestos (WACC a menos de 0,5 puntos de g): ${fuera.join(', ')}.` : '';
    const filas = D.emp.filter((e) => V[e.ticker].valido).map((e) => { const v = V[e.ticker]; return { t: e.ticker, n: e.nombre, px: e.cotizacion, lo: v.bajo / e.cotizacion - 1, ce: v.pot, hi: v.alto / e.cotizacion - 1, ref: D.mo[e.ticker].valor_central / e.cotizacion - 1, v }; })
      .sort((a, b) => b.ce - a.ce);
    const rowH = 34, alto = filas.length * rowH + 44;
    const { svg, tip, w } = lienzo(cont, alto);
    const ml = medir(svg, filas.map((f) => f.n), 12) + 14;
    const mr = medir(svg, filas.map((f) => pct(f.ce, 0, true)), 12) + 18;
    const xs = filas.flatMap((f) => [f.lo, f.hi, f.ref, 0]);
    const x = d3.scaleLinear().domain([Math.min(-1, d3.min(xs)), Math.max(0.2, d3.max(xs))]).nice().range([ml, w - mr]);
    const y = (i) => 24 + i * rowH + rowH / 2;
    const g = svg.append('g');
    const ticks = x.ticks(Math.max(3, Math.floor((w - ml - mr) / 80)));
    g.selectAll('line.gr').data(ticks).join('line').attr('x1', (d) => x(d)).attr('x2', (d) => x(d)).attr('y1', 16).attr('y2', alto - 22).style('stroke', 'var(--cds-chart-grid)');
    g.selectAll('text.tk').data(ticks).join('text').attr('x', (d) => x(d)).attr('y', alto - 6).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text((d) => pct(d, 0, true));
    g.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', 12).attr('y2', alto - 22).style('stroke', 'var(--cds-chart-reference)').attr('stroke-width', 1.5);
    g.append('text').attr('x', x(0) + 4).attr('y', 10).attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text('Cotización');
    const fila = g.selectAll('g.f').data(filas).join('g').attr('class', 'f').style('cursor', 'pointer');
    fila.append('rect').attr('x', 0).attr('width', w).attr('y', (d, i) => y(i) - rowH / 2).attr('height', rowH).style('fill', 'transparent');
    fila.append('rect').attr('x', (d) => x(Math.min(d.lo, d.hi))).attr('width', (d) => Math.max(2, Math.abs(x(d.hi) - x(d.lo)))).attr('y', (d, i) => y(i) - 5).attr('height', 10).attr('rx', 4)
      .style('fill', dash.colors[0]).attr('fill-opacity', (d) => (d.t === S.sel ? 0.4 : 0.22));
    fila.append('line').attr('x1', (d) => x(d.ref)).attr('x2', (d) => x(d.ref)).attr('y1', (d, i) => y(i) - 9).attr('y2', (d, i) => y(i) + 9).style('stroke', 'var(--cds-chart-muted)').attr('stroke-width', 2);
    fila.append('circle').attr('cx', (d) => x(d.ce)).attr('cy', (d, i) => y(i)).attr('r', 5.5).style('fill', dash.colors[0]).style('stroke', 'var(--color-panel)').attr('stroke-width', 2);
    fila.append('text').attr('x', ml - 10).attr('y', (d, i) => y(i)).attr('dy', '0.35em').attr('text-anchor', 'end').attr('font-size', 12)
      .attr('font-weight', (d) => (d.t === S.sel ? 600 : 400)).style('fill', 'var(--color-fg)').text((d) => d.n);
    fila.append('text').attr('x', w - mr + 10).attr('y', (d, i) => y(i)).attr('dy', '0.35em').attr('font-size', 12).attr('font-weight', 600)
      .style('fill', (d) => (d.ce >= 0 ? 'var(--color-ok)' : 'var(--color-bad)')).text((d) => pct(d.ce, 0, true));
    fila.on('click', (ev, d) => { S.sel = d.t; pintar(); })
      .on('mousemove', (ev, d) => {
        linea(tip, [[d.n, null, 'sv-tip-h'], [`Valor central: ${usd(d.v.central)} (${pct(d.ce, 0, true)})`], [`Rango: ${usd(d.v.bajo)} – ${usd(d.v.alto)}`], [`Cotización: ${usd(d.px, 2)}`], [`Informe 10/10: ${usd(D.mo[d.t].valor_central)}`]]);
        tip.style('opacity', 1); const [mx, my] = d3.pointer(ev, cont); moverTip(tip, cont, mx, my);
      })
      .on('mouseleave', () => tip.style('opacity', 0));
  }

  function pintarTabla(V) {
    const tb = $('#sv-tabla tbody');
    tb.classList.remove('dash-skeleton');
    tb.replaceChildren();
    for (const e of D.emp) {
      const v = V[e.ticker], mo = D.mo[e.ticker], ok = v.valido;
      const u = (x) => (ok ? usd(x) : 'n.s.');
      const tr = document.createElement('tr');
      tr.dataset.key = e.ticker; tr.setAttribute('aria-selected', String(e.ticker === S.sel));
      const celdas = [
        [e.nombre, 'sv-strong'], [usd(e.cotizacion, 2)], [pct(v.w, 2)],
        [u(v.res.pes.vps), 'sv-sec-col'], [u(v.res.base.vps), 'sv-sec-col'], [u(v.res.opt.vps), 'sv-sec-col'],
        [u(v.pond)], [usd(v.mm), 'sv-sec-col'], [u(v.central), 'sv-strong'], [ok ? pct(v.pot, 0, true) : 'n.s.', ok ? clsPot(v.pot) : ''],
        [`${usd(mo.valor_central)} · ${pct(mo.potencial, 0, true)}`],
      ];
      for (const [txt, cls] of celdas) { const td = document.createElement('td'); td.textContent = txt; if (cls) td.className = cls; tr.appendChild(td); }
      tb.appendChild(tr);
    }
  }

  function pintarDetalle(V) {
    const e = D.emp.find((x) => x.ticker === S.sel), v = V[e.ticker], aj = S.aj[e.ticker], tray = D.trays[e.ticker], mo = D.mo[e.ticker];
    for (const b of document.querySelectorAll('#sv-emps button')) {
      const t = b.dataset.t; b.setAttribute('aria-pressed', String(t === S.sel));
      const p = b.querySelector('.sv-chip-p'); p.textContent = pct(V[t].pot, 0, true); p.className = 'sv-chip-p ' + clsPot(V[t].pot);
    }
    $('#sv-aj-n').textContent = e.nombre;
    const beta = $('#sv-beta');
    beta.min = Math.max(0.3, Math.round((e.beta - 1) * 100) / 100); beta.max = Math.round((e.beta + 1) * 100) / 100;
    if (document.activeElement !== beta) beta.value = aj.beta;
    $('#sv-beta-v').textContent = num(aj.beta, 2); $('#sv-beta-d').textContent = `Por defecto: ${num(e.beta, 2)} (5 años, Yahoo Finance)`;
    const dg = $('#sv-dg'), dm = $('#sv-dm');
    if (document.activeElement !== dg) dg.value = aj.dg;
    if (document.activeElement !== dm) dm.value = aj.dm;
    const cb = MOTOR.camino(tray.base, aj);
    $('#sv-dg-v').textContent = pp(aj.dg, 1);
    $('#sv-dg-d').textContent = `Caso base, media años 1–5: ${pct(d3.mean(cb.gr.slice(0, 5)), 1)} · por defecto: ${pct(d3.mean(tray.base.gr.slice(0, 5)), 1)}`;
    $('#sv-dm-v').textContent = pp(aj.dm, 1);
    $('#sv-dm-d').textContent = `Caso base, año 10: ${pct(cb.mg[9], 1)} · por defecto: ${pct(tray.base.mg[9], 1)}`;

    // indicadores de la empresa
    const kp = (id, txt, cls) => { const el = $('#' + id); el.classList.remove('sv-pos', 'sv-neg'); if (cls) el.classList.add(cls); el.textContent = txt; };
    kp('e1', usd(v.central)); $('#e1r').replaceChildren(spanPot(v.pot), document.createTextNode(` frente a ${usd(e.cotizacion, 2)} · rango ${usd(v.bajo)} – ${usd(v.alto)}`));
    kp('e2', usd(v.pond)); $('#e2r').textContent = `${ESC.map((sc) => `${NOM_ESC[sc]} ${usd(v.res[sc].vps)}`).join(' · ')} · WACC ${pct(v.w, 2)}`;
    const gi = MOTOR.crecimientoImplicito(e, tray, S.par, aj, v.w, v.res.base.roicT);
    kp('e3', gi == null ? 'n.s.' : pct(gi, 1));
    $('#e3r').textContent = `Caso base: ${pct(d3.mean(cb.gr.slice(0, 5)), 1)} anual · informe 10/10: ${pct(mo.crecimiento_implicito_1a5, 1)}`;
    kp('e4', pct(v.res.base.pesoTv, 0)); $('#e4r').textContent = `ROIC terminal ${pct(v.res.base.roicT, 1)} · g ${pct(v.g, 2)} · ${S.par.metodoVt === 'gordon' ? 'Gordon' : 'inductores'}`;
    const aviso = $('#sv-aviso') || (() => { const p = document.createElement('p'); p.id = 'sv-aviso'; p.className = 'sv-warn'; $('#ajustes').appendChild(p); return p; })();
    aviso.textContent = v.valido ? '' : 'El WACC queda a menos de 0,5 puntos de g: el valor terminal no tiene sentido económico con estos supuestos.';

    // retorno de la nueva inversión
    const aplica = v.ronicImpl != null;
    if (!aplica && aj.invModo === 'explicito') aj.invModo = 'consenso';
    const expl = aj.invModo === 'explicito';
    for (const b of document.querySelectorAll('#sv-inv button')) {
      b.setAttribute('aria-pressed', String(b.dataset.m === aj.invModo));
      b.disabled = b.dataset.m === 'explicito' && !aplica;
    }
    $('#sv-inv-d').textContent = aplica ? 'Por defecto: margen del consenso' : `${e.nombre} apenas necesita capital para crecer: su beneficio no depende de esta palanca.`;
    const ro = $('#sv-ronic'), lg = $('#sv-lag');
    ro.disabled = !expl;
    const ronic = expl ? aj.ronic : v.ronicImpl;
    if (document.activeElement !== ro) ro.value = ronic == null ? 0 : ronic;
    $('#sv-ronic-v').textContent = ronic == null ? 'n.s.' : pct(ronic, 1);
    $('#sv-ronic-d').textContent = aplica ? `Implícita en el consenso: ${pct(v.ronicImpl, 1)} · WACC ${pct(v.w, 1)}` : 'No significativa';
    lg.disabled = !aplica;
    if (document.activeElement !== lg) lg.value = aj.lag;
    $('#sv-lag-v').textContent = aj.lag === 1 ? '1 año' : `${aj.lag} años`;
    $('#sv-lag-d').textContent = 'La inversión de un año empieza a rendir en el año indicado después';
    dm.disabled = expl;
    if (expl) $('#sv-dm-d').textContent = 'Sin efecto: el margen sale del retorno de la inversión';
    kp('e5', ronic == null ? 'n.s.' : pct(ronic, 1), ronic == null ? null : ronic > v.w ? 'sv-pos' : 'sv-neg');
    $('#e5r').textContent = ronic == null ? 'Apenas necesita capital para crecer'
      : `${expl ? 'Supuesto propio' : 'Implícita en el consenso'} · WACC ${pct(v.w, 1)} · ${ronic > v.w ? 'crea valor' : 'no cubre su coste de capital'}`;

    pintarEvolucion(e, v);
    pintarInversion(e, v, ronic);
    pintarFlujos(e, v);
    pintarPuente(e, v);
    pintarSens(e, v, tray, aj);
    pintarMetodos(e, v);
  }
  function spanPot(x) { const s = document.createElement('span'); s.className = clsPot(x); s.textContent = pct(x, 0, true); return s; }

  function resumenSupuestos() {
    const p = S.par;
    $('#ap-sup-r').textContent = `rf ${pct(p.rf, 2)} · ERP ${pct(p.erp, 2)} · g ${pct(p.g, 2)} · ${pct(p.pesoDcf, 0)} DCF`;
  }

  function pintarEstado() {
    const est = D.estado || {};
    const f = est.fecha_mercado || D.pa.fecha_cotizacion;
    const dias = f ? Math.floor((Date.now() - new Date(f + 'T00:00:00Z').getTime()) / 864e5) : null;
    $('#ap-datos').textContent = `Datos del ${fecha(f)}` + (dias != null && dias > 9 ? ` · hace ${dias} días` : '');
    const av = (est.avisos || []).slice();
    if (dias != null && dias > 9) av.push(`Los datos son de hace ${dias} días: la actualización semanal no se ha completado.`);
    const box = $('#ap-avisos'), ul = $('#ap-avisos-l');
    ul.replaceChildren();
    for (const a of av) { const li = document.createElement('li'); li.textContent = a; ul.appendChild(li); }
    box.hidden = av.length === 0;
  }

  function pintarEvolucion(e, v) {
    const cont = $('#sv-ev');
    const filas = (D.hist || []).filter((h) => h.ticker === e.ticker).map((h) => Object.assign({}, h, { d: new Date(h.fecha + 'T00:00:00Z') })).sort((a, b) => a.d - b.d);
    const leg = $('#sv-ev-leg');
    leg.replaceChildren();
    for (const [t, c, tipo] of [['Valor central', dash.colors[0], 'i'], ['Cotización', dash.colors[1], 'i'], ['Simulación actual', 'var(--color-fg)', 'b']]) {
      const s = document.createElement('span'), m = document.createElement(tipo); m.style.background = c; s.append(m, document.createTextNode(t)); leg.appendChild(s);
    }
    if (!filas.length) { cont.replaceChildren(); $('#sv-ev-r').textContent = 'Todavía no hay histórico.'; return; }
    const alto = 230, ult = filas[filas.length - 1], sim = v.central;
    const { svg, tip, w } = lienzo(cont, alto);
    const ys = filas.flatMap((h) => [h.valor_bajo, h.valor_alto, h.cotizacion, h.valor_central]).concat([sim]);
    const y = d3.scaleLinear().domain([d3.min(ys) * 0.9, d3.max(ys) * 1.05]).nice().range([alto - 24, 12]);
    const ml = medir(svg, y.ticks(5).map((t) => num(t, 0)), 11) + 10, mr = 64;
    const d0 = filas[0].d, d1 = ult.d, DIA = 864e5;
    const x = d3.scaleUtc().domain(filas.length > 1 ? [d0, d1] : [new Date(+d0 - 7 * DIA), new Date(+d0 + 7 * DIA)]).range([ml + 8, w - mr]);
    svg.selectAll('line.gr').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', w - mr).attr('y1', (t) => y(t)).attr('y2', (t) => y(t)).style('stroke', 'var(--cds-chart-grid)');
    svg.selectAll('text.yt').data(y.ticks(5)).join('text').attr('x', ml - 8).attr('y', (t) => y(t)).attr('dy', '0.35em').attr('text-anchor', 'end').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text((t) => num(t, 0));
    const xt = filas.length > 1 ? x.ticks(Math.max(2, Math.floor((w - ml - mr) / 90))) : [d0];
    svg.selectAll('text.xt').data(xt).join('text').attr('x', (t) => x(t)).attr('y', alto - 6).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text(d3.utcFormat('%-d/%-m/%y'));
    if (filas.length > 1) {
      svg.append('path').attr('d', d3.area().x((h) => x(h.d)).y0((h) => y(h.valor_bajo)).y1((h) => y(h.valor_alto))(filas)).style('fill', dash.colors[0]).attr('fill-opacity', 0.14);
      svg.append('path').attr('d', d3.line().x((h) => x(h.d)).y((h) => y(h.valor_central))(filas)).style('fill', 'none').style('stroke', dash.colors[0]).attr('stroke-width', 2).attr('stroke-linejoin', 'round');
      svg.append('path').attr('d', d3.line().x((h) => x(h.d)).y((h) => y(h.cotizacion))(filas)).style('fill', 'none').style('stroke', dash.colors[1]).attr('stroke-width', 2).attr('stroke-linejoin', 'round');
    } else {
      svg.append('rect').attr('x', x(d0) - 6).attr('width', 12).attr('y', y(ult.valor_alto)).attr('height', Math.max(2, y(ult.valor_bajo) - y(ult.valor_alto))).attr('rx', 4).style('fill', dash.colors[0]).attr('fill-opacity', 0.14);
    }
    svg.selectAll('circle.c').data(filas).join('circle').attr('cx', (h) => x(h.d)).attr('cy', (h) => y(h.valor_central)).attr('r', 4).style('fill', dash.colors[0]).style('stroke', 'var(--color-panel)').attr('stroke-width', 1.5);
    svg.selectAll('circle.p').data(filas).join('circle').attr('cx', (h) => x(h.d)).attr('cy', (h) => y(h.cotizacion)).attr('r', 4).style('fill', dash.colors[1]).style('stroke', 'var(--color-panel)').attr('stroke-width', 1.5);
    const cambiado = Math.abs(sim - ult.valor_central) > 0.005 * Math.abs(ult.valor_central);
    if (cambiado) svg.append('path').attr('d', d3.symbol(d3.symbolDiamond, 80)()).attr('transform', `translate(${x(d1)},${y(sim)})`).style('fill', 'var(--color-fg)').style('stroke', 'var(--color-panel)').attr('stroke-width', 1.5);
    const fin = [{ v: ult.valor_central, c: 'var(--color-fg)' }, { v: ult.cotizacion, c: 'var(--color-fg)' }].map((o) => Object.assign(o, { y: y(o.v) })).sort((a, b) => a.y - b.y);
    if (fin[1].y - fin[0].y < 13) fin[1].y = fin[0].y + 13;
    for (const o of fin) svg.append('text').attr('x', w - mr + 8).attr('y', o.y).attr('dy', '0.35em').attr('font-size', 11).style('fill', o.c).text(usd(o.v));
    const guia = svg.append('line').attr('y1', 12).attr('y2', alto - 24).style('stroke', 'var(--cds-chart-axis)').attr('opacity', 0);
    svg.append('rect').attr('x', ml).attr('width', w - ml - mr).attr('y', 0).attr('height', alto - 20).style('fill', 'transparent')
      .on('mousemove', (ev) => {
        const [mx, my] = d3.pointer(ev);
        const h = filas.reduce((a, b) => (Math.abs(x(b.d) - mx) < Math.abs(x(a.d) - mx) ? b : a));
        guia.attr('x1', x(h.d)).attr('x2', x(h.d)).attr('opacity', 1);
        linea(tip, [[`Semana del ${fecha(h.fecha)}`, null, 'sv-tip-h'], [`Valor central: ${usd(h.valor_central)} (${pct(h.potencial, 0, true)})`, dash.colors[0]],
          [`Rango: ${usd(h.valor_bajo)} – ${usd(h.valor_alto)}`], [`Cotización: ${usd(h.cotizacion, 2)}`, dash.colors[1]], [`WACC: ${pct(h.wacc, 2)}`]]);
        tip.style('opacity', 1); moverTip(tip, cont, mx, my);
      })
      .on('mouseleave', () => { tip.style('opacity', 0); guia.attr('opacity', 0); });
    const pr = (((D.estado || {}).empresas || {})[e.ticker] || {}).proximos_resultados;
    let txt;
    if (filas.length > 1) {
      const ant = filas[filas.length - 2];
      txt = `Respecto a la semana anterior: valor central ${pct(ult.valor_central / ant.valor_central - 1, 1, true)}, cotización ${pct(ult.cotizacion / ant.cotizacion - 1, 1, true)}.`;
    } else txt = `La serie empieza el ${fecha(ult.fecha)}; cada lunes se añade un punto.`;
    if (cambiado) txt += ` Simulación actual: ${usd(sim)}.`;
    if (pr) txt += ` Próximos resultados: ${fecha(pr)}.`;
    $('#sv-ev-r').textContent = txt;
  }

  function pintarInversion(e, v, ronic) {
    const cont = $('#sv-iv'), r = v.res.base;
    const C = { actual: 'var(--cds-chart-muted)', nuevo: dash.colors[0], inv: dash.colors[1] };
    const NOM = { actual: 'NOPAT del negocio actual', nuevo: 'NOPAT de la nueva inversión', inv: 'Inversión de crecimiento' };
    const leg = $('#sv-iv-leg'); leg.replaceChildren();
    for (const k of ['actual', 'nuevo', 'inv']) { const sp = document.createElement('span'); const i = document.createElement('i'); i.style.background = C[k]; i.style.height = '.55rem'; sp.append(i, document.createTextNode(NOM[k])); leg.appendChild(sp); }
    { const sp = document.createElement('span'); const bb = document.createElement('b'); bb.style.background = 'var(--color-fg)'; sp.append(bb, document.createTextNode('Flujo de caja libre')); leg.appendChild(sp); }
    const filas = [{ lab: 'TTM', actual: r.nopat0, nuevo: 0, inv: -r.reinv0, fcf: r.nopat0 - r.reinv0 }]
      .concat(r.filas.map((f) => ({ lab: String(f.anio), actual: f.nopatActual, nuevo: f.nopatNuevo, inv: -f.reinv, fcf: f.fcff })));
    for (const f of filas) {
      let up = 0, dn = 0; f.seg = [];
      for (const k of ['actual', 'nuevo', 'inv']) {
        const x = f[k] / 1000;
        if (x >= 0) { f.seg.push({ k, a: up, b: up + x }); up += x; } else { f.seg.push({ k, a: dn + x, b: dn }); dn += x; }
      }
      f.max = up; f.min = dn;
    }
    const alto = 260;
    const { svg, tip, w } = lienzo(cont, alto);
    const y = d3.scaleLinear().domain([Math.min(0, d3.min(filas, (f) => Math.min(f.min, f.fcf / 1000))), d3.max(filas, (f) => Math.max(f.max, f.fcf / 1000))]).nice().range([alto - 24, 10]);
    const ml = medir(svg, y.ticks(5).map((d) => num(d, 0)), 11) + 10;
    const x = d3.scaleBand().domain(filas.map((f) => f.lab)).range([ml, w]).padding(0.28);
    svg.selectAll('line.gr').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', w).attr('y1', (d) => y(d)).attr('y2', (d) => y(d)).style('stroke', (d) => (d === 0 ? 'var(--cds-chart-axis)' : 'var(--cds-chart-grid)'));
    svg.selectAll('text.yt').data(y.ticks(5)).join('text').attr('x', ml - 8).attr('y', (d) => y(d)).attr('dy', '0.35em').attr('text-anchor', 'end').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text((d) => num(d, 0));
    svg.selectAll('text.xt').data(filas).join('text').attr('x', (f) => x(f.lab) + x.bandwidth() / 2).attr('y', alto - 6).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text((f) => f.lab);
    const bw = Math.min(32, x.bandwidth());
    const col = svg.selectAll('g.col').data(filas).join('g');
    col.each(function (f) {
      const g = d3.select(this), x0 = x(f.lab) + (x.bandwidth() - bw) / 2;
      for (const sg of f.seg) {
        if (Math.abs(sg.b - sg.a) < 1e-9) continue;
        g.append('rect').attr('x', x0).attr('width', bw).attr('y', y(sg.b)).attr('height', Math.max(1, y(sg.a) - y(sg.b))).attr('rx', 2)
          .style('fill', C[sg.k]).style('stroke', 'var(--color-panel)').attr('stroke-width', 1);
      }
    });
    const ln = d3.line().x((f) => x(f.lab) + x.bandwidth() / 2).y((f) => y(f.fcf / 1000));
    svg.append('path').attr('d', ln(filas)).style('fill', 'none').style('stroke', 'var(--color-fg)').attr('stroke-width', 1.5).attr('stroke-dasharray', '3 3').style('pointer-events', 'none');
    svg.selectAll('circle.fcf').data(filas).join('circle').attr('cx', (f) => x(f.lab) + x.bandwidth() / 2).attr('cy', (f) => y(f.fcf / 1000)).attr('r', 4)
      .style('fill', 'var(--color-fg)').style('stroke', 'var(--color-panel)').attr('stroke-width', 1.5).style('pointer-events', 'none');
    col.append('rect').attr('x', (f) => x(f.lab)).attr('width', x.bandwidth()).attr('y', 0).attr('height', alto - 20).style('fill', 'transparent')
      .on('mousemove', (ev, f) => {
        linea(tip, [[f.lab === 'TTM' ? 'Últimos doce meses (TTM)' : `Año ${f.lab.replace('Año ', '')}`, null, 'sv-tip-h'],
          [`${NOM.actual}: ${num(f.actual / 1000, 1)}`, C.actual], [`${NOM.nuevo}: ${num(f.nuevo / 1000, 1)}`, C.nuevo], [`${NOM.inv}: ${num(f.inv / 1000, 1)}`, C.inv],
          [`Flujo de caja libre: ${num(f.fcf / 1000, 1)} mil M$`, 'var(--color-fg)']]);
        tip.style('opacity', 1); const [mx, my] = d3.pointer(ev, cont); moverTip(tip, cont, mx, my);
      })
      .on('mouseleave', () => tip.style('opacity', 0));
    const sc = MOTOR.valorSinCrecimiento(e, v.w);
    $('#sv-iv-r').textContent = (ronic == null ? `${e.nombre} apenas necesita capital para crecer. ` : `Rentabilidad de la nueva inversión: ${pct(ronic, 1)} frente a un WACC del ${pct(v.w, 1)}. `) +
      `Sin crecer (NOPAT actual a perpetuidad), valdría ${usd(sc)} por acción; el crecimiento aporta ${num(r.vps - sc, 0, true)} $ hasta los ${usd(r.vps)} del caso base.`;
  }

  function pintarFlujos(e, v) {
    const cont = $('#sv-fl');
    const series = [['base', dash.colors[0]], ['pes', dash.colors[1]], ['opt', dash.colors[2]]];
    const leg = $('#sv-fl-leg'); leg.replaceChildren();
    for (const [sc, col] of series) { const s = document.createElement('span'); const i = document.createElement('i'); i.style.background = col; s.append(i, document.createTextNode(NOM_ESC[sc])); leg.appendChild(s); }
    const alto = 230;
    const { svg, tip, w } = lienzo(cont, alto);
    const vals = series.flatMap(([sc]) => v.res[sc].filas.map((f) => f.fcff / 1000));
    const y = d3.scaleLinear().domain([Math.min(0, d3.min(vals)), d3.max(vals)]).nice().range([alto - 26, 10]);
    const ml = medir(svg, y.ticks(5).map((d) => num(d, 0)), 11) + 10, mr = 64;
    const x = d3.scaleLinear().domain([1, 10]).range([ml, w - mr]);
    svg.selectAll('line.gr').data(y.ticks(5)).join('line').attr('x1', ml).attr('x2', w - mr).attr('y1', (d) => y(d)).attr('y2', (d) => y(d)).style('stroke', (d) => (d === 0 ? 'var(--cds-chart-axis)' : 'var(--cds-chart-grid)'));
    svg.selectAll('text.yt').data(y.ticks(5)).join('text').attr('x', ml - 8).attr('y', (d) => y(d)).attr('dy', '0.35em').attr('text-anchor', 'end').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text((d) => num(d, 0));
    svg.selectAll('text.xt').data([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).join('text').attr('x', (d) => x(d)).attr('y', alto - 6).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text((d) => (d === 1 ? 'Año 1' : d));
    const ln = d3.line().x((f) => x(f.anio)).y((f) => y(f.fcff / 1000));
    const ends = [];
    for (const [sc, col] of series) {
      svg.append('path').attr('d', ln(v.res[sc].filas)).style('fill', 'none').style('stroke', col).attr('stroke-width', sc === 'base' ? 2.5 : 2).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
      const f10 = v.res[sc].filas[9];
      ends.push({ sc, col, y: y(f10.fcff / 1000), val: f10.fcff / 1000 });
    }
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    for (const en of ends) svg.append('text').attr('x', w - mr + 6).attr('y', en.y).attr('dy', '0.35em').attr('font-size', 11).style('fill', 'var(--color-fg)').text(num(en.val, 0));
    const guia = svg.append('line').attr('y1', 10).attr('y2', alto - 26).style('stroke', 'var(--cds-chart-axis)').attr('opacity', 0);
    svg.append('rect').attr('x', ml).attr('width', w - ml - mr).attr('y', 0).attr('height', alto - 20).style('fill', 'transparent')
      .on('mousemove', (ev) => {
        const [mx, my] = d3.pointer(ev); const a = Math.max(1, Math.min(10, Math.round(x.invert(mx))));
        guia.attr('x1', x(a)).attr('x2', x(a)).attr('opacity', 1);
        linea(tip, [[`Año ${a}`, null, 'sv-tip-h']].concat(series.map(([sc, col]) => [`${NOM_ESC[sc]}: ${num(v.res[sc].filas[a - 1].fcff / 1000, 1)} mil M$`, col])));
        tip.style('opacity', 1); moverTip(tip, cont, mx, my);
      })
      .on('mouseleave', () => { tip.style('opacity', 0); guia.attr('opacity', 0); });
  }

  function pintarPuente(e, v) {
    const cont = $('#sv-pu'), b = v.res.base, p = b.puente;
    const pasos = [
      { n: 'Flujos años 1–10', v: b.va, tipo: 'suma' },
      { n: 'Valor terminal', v: b.vaTv, tipo: 'suma' },
      { n: 'Deuda neta', v: -p.dfn, tipo: 'ajuste' },
      { n: 'Minoritarios y preferentes', v: -(p.minoritarios + p.preferentes), tipo: 'ajuste' },
      { n: 'Inversiones no operativas', v: p.inversiones, tipo: 'ajuste' },
      { n: 'Patrimonio', v: b.eq, tipo: 'total' },
    ].filter((s) => s.tipo !== 'ajuste' || Math.abs(s.v) > 0.5);
    let acc = 0;
    for (const s of pasos) { if (s.tipo === 'total') { s.a = 0; s.b = s.v; } else { s.a = acc; acc += s.v; s.b = acc; } }
    const alto = 250;
    const { svg, tip, w } = lienzo(cont, alto);
    const ys = pasos.flatMap((s) => [s.a / 1000, s.b / 1000]);
    const y = d3.scaleLinear().domain([Math.min(0, d3.min(ys)), d3.max(ys)]).nice().range([alto - 48, 18]);
    const ml = medir(svg, y.ticks(4).map((d) => num(d, 0)), 11) + 10;
    const x = d3.scaleBand().domain(pasos.map((s) => s.n)).range([ml, w]).padding(0.28);
    svg.selectAll('line.gr').data(y.ticks(4)).join('line').attr('x1', ml).attr('x2', w).attr('y1', (d) => y(d)).attr('y2', (d) => y(d)).style('stroke', (d) => (d === 0 ? 'var(--cds-chart-axis)' : 'var(--cds-chart-grid)'));
    svg.selectAll('text.yt').data(y.ticks(4)).join('text').attr('x', ml - 8).attr('y', (d) => y(d)).attr('dy', '0.35em').attr('text-anchor', 'end').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text((d) => num(d, 0));
    const col = (s) => (s.tipo === 'total' ? 'var(--color-fg)' : s.v >= 0 ? dash.colors[0] : dash.colors[1]);
    const bw = Math.min(56, x.bandwidth());
    const gb = svg.selectAll('g.b').data(pasos).join('g');
    gb.append('rect').attr('x', (s) => x(s.n) + (x.bandwidth() - bw) / 2).attr('width', bw).attr('y', (s) => y(Math.max(s.a, s.b) / 1000)).attr('height', (s) => Math.max(1.5, Math.abs(y(s.a / 1000) - y(s.b / 1000)))).attr('rx', 3)
      .style('fill', col).attr('fill-opacity', (s) => (s.tipo === 'total' ? 0.75 : 0.9));
    gb.append('text').attr('x', (s) => x(s.n) + x.bandwidth() / 2).attr('y', (s) => y(Math.max(s.a, s.b) / 1000) - 5).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', 'var(--color-fg)')
      .text((s) => num(s.v / 1000, 0, s.tipo === 'ajuste'));
    const lab = svg.selectAll('text.xl').data(pasos).join('text').attr('x', (s) => x(s.n) + x.bandwidth() / 2).attr('y', alto - 32).attr('text-anchor', 'middle').attr('font-size', w < 480 ? 9.5 : 10.5).style('fill', 'var(--color-fg-muted)');
    lab.each(function (s) {
      const palabras = s.n.split(' '), t = d3.select(this), maxW = x.bandwidth() + 8;
      let lin = [], n = 0, ts = t.append('tspan').attr('x', x(s.n) + x.bandwidth() / 2).attr('dy', 0);
      for (const pz of palabras) {
        lin.push(pz); ts.text(lin.join(' '));
        if (ts.node().getComputedTextLength() > maxW && lin.length > 1) { lin.pop(); ts.text(lin.join(' ')); lin = [pz]; n++; ts = t.append('tspan').attr('x', x(s.n) + x.bandwidth() / 2).attr('dy', '1.15em').text(pz); }
      }
    });
    $('#sv-pu-r').textContent = `Patrimonio de ${num(b.eq / 1000, 0)} mil M$ ÷ ${num(e.acciones_m, 0)} millones de acciones = ${usd(b.vps)} por acción en el caso base.`;
    gb.on('mousemove', (ev, s) => {
      linea(tip, [[s.n, null, 'sv-tip-h'], [`${num(s.v / 1000, 1, s.tipo === 'ajuste')} mil M$`], [s.tipo === 'total' ? `${usd(b.vps)} por acción` : `${pct(s.v / b.ev, 0)} del valor de la empresa`]]);
      tip.style('opacity', 1); const [mx, my] = d3.pointer(ev, cont); moverTip(tip, cont, mx, my);
    }).on('mouseleave', () => tip.style('opacity', 0));
  }

  function pintarSens(e, v, tray, aj) {
    const cont = $('#sv-se');
    const pasos = [-0.015, -0.01, -0.005, 0, 0.005, 0.01, 0.015];
    const ws = pasos.map((d) => v.w + d), gs = pasos.map((d) => v.g + d);
    const rt = v.res.base.roicT;
    const celdas = [];
    ws.forEach((w, i) => gs.forEach((g, j) => {
      const r = w - g >= 0.005 ? MOTOR.sensibilidad(e, tray, S.par, aj, w, g, rt) : null;
      celdas.push({ i, j, w, g, vps: r ? r.vps : null });
    }));
    const alto = 34 + ws.length * 32;
    const { svg, tip, w } = lienzo(cont, alto);
    const ml = medir(svg, ws.map((x) => pct(x, 1)), 11) + 16;
    const cw = (w - ml) / gs.length, ch = 30;
    const ok = colorDe('var(--color-ok)'), bad = colorDe('var(--color-bad)');
    svg.append('text').attr('x', ml).attr('y', 10).attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text('g →');
    svg.append('text').attr('x', 0).attr('y', 10).attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text('WACC ↓');
    gs.forEach((g, j) => svg.append('text').attr('x', ml + cw * j + cw / 2).attr('y', 26).attr('text-anchor', 'middle').attr('font-size', 11)
      .attr('font-weight', j === 3 ? 600 : 400).style('fill', j === 3 ? 'var(--color-fg)' : 'var(--color-fg-muted)').text(pct(g, 1)));
    ws.forEach((x, i) => svg.append('text').attr('x', ml - 8).attr('y', 34 + i * 32 + ch / 2).attr('dy', '0.35em').attr('text-anchor', 'end').attr('font-size', 11)
      .attr('font-weight', i === 3 ? 600 : 400).style('fill', i === 3 ? 'var(--color-fg)' : 'var(--color-fg-muted)').text(pct(x, 1)));
    const gc = svg.selectAll('g.c').data(celdas).join('g');
    gc.append('rect').attr('x', (c) => ml + c.j * cw + 1).attr('y', (c) => 34 + c.i * 32).attr('width', cw - 2).attr('height', ch).attr('rx', 3)
      .style('fill', (c) => (c.vps == null ? 'var(--color-bg)' : c.vps >= e.cotizacion ? ok : bad))
      .attr('fill-opacity', (c) => (c.vps == null ? 1 : 0.1 + 0.5 * Math.min(1, Math.abs(c.vps / e.cotizacion - 1))))
      .style('stroke', (c) => (c.i === 3 && c.j === 3 ? 'var(--color-fg)' : 'none')).attr('stroke-width', 1.5);
    gc.append('text').attr('x', (c) => ml + c.j * cw + cw / 2).attr('y', (c) => 34 + c.i * 32 + ch / 2).attr('dy', '0.35em').attr('text-anchor', 'middle')
      .attr('font-size', cw < 46 ? 10 : 11.5).attr('font-weight', (c) => (c.i === 3 && c.j === 3 ? 600 : 400)).style('fill', 'var(--color-fg)')
      .text((c) => (c.vps == null ? 'n.s.' : num(c.vps, 0)));
    gc.on('mousemove', (ev, c) => {
      linea(tip, [[`WACC ${pct(c.w, 2)} · g ${pct(c.g, 2)}`, null, 'sv-tip-h'], [c.vps == null ? 'WACC demasiado cerca de g' : `${usd(c.vps)} por acción (${pct(c.vps / e.cotizacion - 1, 0, true)})`]]);
      tip.style('opacity', 1); const [mx, my] = d3.pointer(ev, cont); moverTip(tip, cont, mx, my);
    }).on('mouseleave', () => tip.style('opacity', 0));
  }

  function pintarMetodos(e, v) {
    const cont = $('#sv-me'), mu = D.mu[e.ticker], pw = S.par.pesoDcf;
    const met = [
      { n: 'DCF por escenarios', lo: v.res.pes.vps, ce: v.pond, hi: v.res.opt.vps },
      { n: 'PER adelantado', lo: mu.per_valor_min, ce: mu.per_valor_mediana, hi: mu.per_valor_max },
      { n: 'EV/EBITDA adelantado', lo: mu.ev_ebitda_valor_min, ce: mu.ev_ebitda_valor_mediana, hi: mu.ev_ebitda_valor_max },
      { n: 'Valor central', lo: v.bajo, ce: v.central, hi: v.alto, total: true },
    ];
    const rowH = 36, alto = met.length * rowH + 40;
    const { svg, tip, w } = lienzo(cont, alto);
    const ml = medir(svg, met.map((m) => m.n), 12) + 14;
    const xmax = Math.max(e.cotizacion * 1.25, v.alto * 1.15, Math.min(d3.max(met, (m) => m.hi), e.cotizacion * 3));
    const x = d3.scaleLinear().domain([0, xmax]).nice().range([ml, w - 12]);
    const xm = x.domain()[1];
    const ticks = x.ticks(Math.max(3, Math.floor((w - ml) / 80)));
    svg.selectAll('line.gr').data(ticks).join('line').attr('x1', (d) => x(d)).attr('x2', (d) => x(d)).attr('y1', 14).attr('y2', alto - 22).style('stroke', 'var(--cds-chart-grid)');
    svg.selectAll('text.tk').data(ticks).join('text').attr('x', (d) => x(d)).attr('y', alto - 6).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text((d) => num(d, 0));
    const y = (i) => 22 + i * rowH + rowH / 2;
    const gm = svg.selectAll('g.m').data(met).join('g');
    gm.append('rect').attr('x', (m) => x(Math.max(0, Math.min(m.lo, xm)))).attr('width', (m) => Math.max(2, x(Math.min(m.hi, xm)) - x(Math.max(0, Math.min(m.lo, xm))))).attr('y', (m, i) => y(i) - 7).attr('height', 14).attr('rx', 4)
      .style('fill', (m) => (m.total ? 'var(--color-fg)' : dash.colors[0])).attr('fill-opacity', (m) => (m.total ? 0.22 : 0.26));
    gm.append('line').attr('x1', (m) => x(Math.min(m.ce, xm))).attr('x2', (m) => x(Math.min(m.ce, xm))).attr('y1', (m, i) => y(i) - 10).attr('y2', (m, i) => y(i) + 10)
      .style('stroke', (m) => (m.total ? 'var(--color-fg)' : dash.colors[0])).attr('stroke-width', 2.5);
    gm.append('text').attr('x', ml - 10).attr('y', (m, i) => y(i)).attr('dy', '0.35em').attr('text-anchor', 'end').attr('font-size', 12).attr('font-weight', (m) => (m.total ? 600 : 400)).style('fill', 'var(--color-fg)').text((m) => m.n);
    gm.filter((m) => m.hi > xm).append('text').attr('x', w - 12).attr('y', (m) => y(met.indexOf(m)) - 12).attr('text-anchor', 'end').attr('font-size', 10.5).style('fill', 'var(--color-fg-muted)').text((m) => `hasta ${num(m.hi, 0)} ›`);
    svg.append('line').attr('x1', x(e.cotizacion)).attr('x2', x(e.cotizacion)).attr('y1', 10).attr('y2', alto - 22).style('stroke', dash.colors[1]).attr('stroke-width', 2);
    svg.append('text').attr('x', x(e.cotizacion)).attr('y', 8).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', 'var(--color-fg)').text(`Cotización ${usd(e.cotizacion, 0)}`);
    gm.on('mousemove', (ev, m) => {
      const extra = m.total ? `${pct(pw, 0)} DCF + ${pct(1 - pw, 0)} múltiplos` : m.n.startsWith('DCF') ? 'Pesimista · ponderado · optimista' : 'Mínimo · mediana · máximo de los comparables';
      linea(tip, [[m.n, null, 'sv-tip-h'], [`${usd(m.lo)} · ${usd(m.ce)} · ${usd(m.hi)}`], [extra]]);
      tip.style('opacity', 1); const [mx, my] = d3.pointer(ev, cont); moverTip(tip, cont, mx, my);
    }).on('mouseleave', () => tip.style('opacity', 0));
  }

  function placeholder() {
    for (const id of ['#sv-pot', '#sv-fl', '#sv-pu', '#sv-se', '#sv-me']) { const c = $(id); c.replaceChildren(); }
    const err = IDS.map((id) => dash.data(id)).find((s) => s.status === 'error');
    if (err) {
      const c = $('#sv-pot'); c.classList.remove('dash-skeleton');
      const p = document.createElement('p'); p.className = 'sv-card-n'; p.textContent = 'No se han podido cargar los datos del modelo.'; c.appendChild(p);
    }
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (D) pintar(); });
  dash.onData(() => {
    if (!D) {
      const d = cargar();
      if (!d) { placeholder(); return; }
      D = d; iniciar();
    }
    pintar();
  });
})();

// Simulador 7M · instalación, funcionamiento sin conexión y arranque
(function () {
  const VERSION = '1.0.0';
  const v = document.getElementById('ap-version'); if (v) v.textContent = `app ${VERSION}.`;
  const sup = document.getElementById('ap-sup');
  if (window.matchMedia('(max-width: 1099px)').matches) sup.open = false;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    let recargado = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!recargado && navigator.serviceWorker.controller) { recargado = true; location.reload(); } });
  }
  let diferido = null;
  const bi = document.getElementById('ap-instalar');
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); diferido = e; bi.hidden = false; });
  bi.addEventListener('click', async () => { if (!diferido) return; diferido.prompt(); try { await diferido.userChoice; } catch (e) {} diferido = null; bi.hidden = true; });
  window.addEventListener('appinstalled', () => { bi.hidden = true; });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const instalada = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let visto = false;
  try { visto = localStorage.getItem('ap-ios-visto') === '1'; } catch (e) {}
  if (ios && !instalada && !visto) document.getElementById('ap-ios').hidden = false;
  document.getElementById('ap-ios-x').addEventListener('click', () => {
    document.getElementById('ap-ios').hidden = true;
    try { localStorage.setItem('ap-ios-visto', '1'); } catch (e) {}
  });
  const off = document.getElementById('ap-off');
  const conexion = () => { off.hidden = navigator.onLine; };
  conexion();
  window.addEventListener('online', conexion);
  window.addEventListener('offline', conexion);
  dash.cargar();
})();

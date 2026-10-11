// Motor de valoración del simulador: réplica en JavaScript de motor3.py (DCF a 10 años desde las cifras TTM,
// valor terminal por inductores o Gordon, escenarios ponderados y conciliación con múltiplos adelantados).
// Añade un modo de "retorno explícito de la inversión": el NOPAT de cada año = NOPAT actual + RONIC × inversión
// neta acumulada (CapEx − amortización + variación de NOF) con un retardo de L años, en lugar del margen del consenso.
(function (raiz) {
  const ESC = ['pes', 'base', 'opt'];

  function wacc(emp, par, aj) {
    const beta = aj && aj.beta != null ? aj.beta : emp.beta;
    const ke = par.rf + beta * par.erp + emp.prima_pais;
    const kd = par.rf + par.spread;
    const D = emp.deuda_bruta, E = emp.cotizacion * emp.acciones_m;
    const wd = D / (D + E);
    const w = (1 - wd) * ke + wd * kd * (1 - emp.tipo_impositivo) + (par.dwacc || 0);
    return { ke, kd, wd, beta, wacc: w };
  }

  // Ajustes de la empresa: dg = puntos de crecimiento en los años 1-9 (se desvanece hasta 0 en el año 10);
  // dm = puntos de margen EBIT a largo plazo (los años 1-2 siguen al consenso; el ajuste llega entero al año 10).
  function camino(base, aj) {
    const dg = (aj && aj.dg) || 0, dm = (aj && aj.dm) || 0;
    return {
      gr: base.gr.map((x, k) => x + dg * (1 - k / 9)),
      mg: base.mg.map((x, k) => (k < 2 ? x : x + dm * (k - 1) / 8)),
      da: base.da, cx: base.cx, nf: base.nf,
    };
  }

  // inv (opcional): {ronic, lag} activa el retorno explícito de la inversión.
  function dcf(emp, cam, w, g, fr, roicTope, metodoVt, roicFijo, inv) {
    const tax = emp.tipo_impositivo, d = emp.anios_hasta_valoracion;
    const nopat0 = emp.ebit_ttm * (1 - tax), reinv0 = emp.inversion_neta_ttm;
    // ventas e inversión de cada año (no dependen del NOPAT)
    let vPrev = emp.ventas_ttm, nofPrev = vPrev * emp.nof_ventas_ttm;
    const base = [];
    for (let k = 0; k < 10; k++) {
      const v = vPrev * (1 + cam.gr[k]);
      const da = v * cam.da[k], cx = v * cam.cx[k], nof = v * cam.nf[k], dnof = nof - nofPrev;
      base.push({ v, da, cx, nof, dnof, reinv: cx - da + dnof });
      vPrev = v; nofPrev = nof;
    }
    const inversiones = [reinv0].concat(base.map((b) => b.reinv)); // índice = año (0 = últimos doce meses)
    let ic = emp.capital_invertido, va = 0;
    const filas = [];
    for (let k = 0; k < 10; k++) {
      const b = base[k], anio = k + 1;
      let nopat, ebit;
      if (inv) {
        let acum = 0;
        for (let j = 0; j <= anio - inv.lag; j++) acum += inversiones[j];
        nopat = nopat0 + inv.ronic * acum; ebit = nopat / (1 - tax);
      } else {
        ebit = b.v * cam.mg[k]; nopat = ebit * (1 - tax);
      }
      const fcff = nopat - b.reinv;
      const fd = Math.pow(1 + w, -(k + 0.5 - d));
      va += fcff * fd;
      filas.push({ anio, ventas: b.v, ebit, margen: ebit / b.v, crecimiento: cam.gr[k], nopat, nopatActual: nopat0, nopatNuevo: nopat - nopat0,
        reinv: b.reinv, capex: b.cx, amort: b.da, fcff, va: fcff * fd, icIni: ic });
      ic += b.reinv;
    }
    const f10 = filas[9];
    const roic10 = f10.icIni > 0 ? f10.nopat / f10.icIni : null;
    let rt = roicFijo;
    if (rt == null) {
      const cap = Math.min(Math.max(roic10 || w, w), roicTope);
      rt = w + fr * (cap - w);
    }
    rt = Math.max(rt, g + 0.005);
    const nopat11 = f10.ebit * (1 + g) * (1 - tax);
    const tv = metodoVt === 'gordon' ? f10.fcff * (1 + g) / (w - g) : nopat11 * (1 - g / rt) / (w - g);
    const fdTv = Math.pow(1 + w, -(10 - d));
    const ev = va + tv * fdTv;
    const puente = { dfn: emp.deuda_financiera_neta, minoritarios: emp.minoritarios, preferentes: emp.preferentes, inversiones: emp.inversiones_no_operativas };
    const eq = ev - puente.dfn - puente.minoritarios - puente.preferentes + puente.inversiones;
    return { vps: eq / emp.acciones_m, ev, eq, va, vaTv: tv * fdTv, pesoTv: (tv * fdTv) / ev, roicT: rt, roic10, filas, puente, nopat0, reinv0, inversiones,
      valido: w - g >= 0.005 };
  }

  // Rentabilidad de la nueva inversión que supone una proyección: (NOPAT del año 10 − NOPAT actual) / inversión neta
  // acumulada hasta el año 10 − L (incluida la de los últimos doce meses). null si no es significativa.
  function ronicImplicito(r, lag) {
    let acum = 0;
    for (let j = 0; j <= 10 - lag; j++) acum += r.inversiones[j];
    const x = acum > 0 ? (r.filas[9].nopat - r.nopat0) / acum : null;
    return x != null && x > -0.5 && x < 1 ? x : null;
  }

  // Valor por acción sin crecimiento: el NOPAT actual a perpetuidad (la inversión solo repone la amortización).
  function valorSinCrecimiento(emp, w) {
    const ev = (emp.ebit_ttm * (1 - emp.tipo_impositivo)) / w;
    return (ev - emp.deuda_financiera_neta - emp.minoritarios - emp.preferentes + emp.inversiones_no_operativas) / emp.acciones_m;
  }

  function invDe(aj) { return aj && aj.invModo === 'explicito' && aj.ronic != null ? { ronic: aj.ronic, lag: aj.lag || 1 } : null; }

  function valorar(emp, tray, mul, par, aj) {
    const W = wacc(emp, par, aj), w = W.wacc, g = par.g, inv = invDe(aj);
    const cons = {};
    for (const sc of ESC) cons[sc] = dcf(emp, camino(tray[sc], aj), w, g, par.fr[sc], par.roicTope, par.metodoVt, null, null);
    const lag = (aj && aj.lag) || 1;
    const ronicImpl = ronicImplicito(cons.base, lag);
    let res = cons;
    if (inv) {
      // cada escenario conserva su optimismo relativo: su RONIC implícito respecto al del caso base
      res = {};
      for (const sc of ESC) {
        const rs = ronicImplicito(cons[sc], inv.lag), f = ronicImpl && rs ? rs / ronicImpl : 1;
        res[sc] = dcf(emp, camino(tray[sc], aj), w, g, par.fr[sc], par.roicTope, par.metodoVt, null, { ronic: inv.ronic * f, lag: inv.lag });
      }
    }
    const pr = par.prob;
    const pond = pr.pes * res.pes.vps + pr.base * res.base.vps + pr.opt * res.opt.vps;
    const meds = [mul.per_valor_mediana, mul.ev_ebitda_valor_mediana];
    const mm = (meds[0] + meds[1]) / 2, pw = par.pesoDcf;
    const central = pw * pond + (1 - pw) * mm;
    const bajo = pw * res.pes.vps + (1 - pw) * Math.min(meds[0], meds[1]);
    const alto = pw * res.opt.vps + (1 - pw) * Math.max(meds[0], meds[1]);
    const valido = ESC.every((sc) => res[sc].valido);
    return { W, w, g, res, cons, pond, mm, central, bajo, alto, pot: central / emp.cotizacion - 1, valido, inv, ronicImpl, lag };
  }

  // Valor del caso base con otro WACC y otro g, con el ROIC terminal del caso base fijo (como la tabla de sensibilidad del informe).
  function sensibilidad(emp, tray, par, aj, w, g, roicT) {
    return dcf(emp, camino(tray.base, aj), w, g, par.fr.base, par.roicTope, par.metodoVt, roicT, invDe(aj));
  }

  // DCF inverso: crecimiento anual de los años 1-5 (después converge al del año 10) que iguala el caso base a la cotización.
  function crecimientoImplicito(emp, tray, par, aj, w, roicT) {
    const c0 = camino(tray.base, aj), g10 = c0.gr[9], inv = invDe(aj);
    const f = (x) => {
      const gr = [x, x, x, x, x].concat([1, 2, 3, 4, 5].map((j) => x + (g10 - x) * j / 5));
      return dcf(emp, Object.assign({}, c0, { gr }), w, par.g, par.fr.base, par.roicTope, par.metodoVt, roicT, inv).vps - emp.cotizacion;
    };
    let lo = -0.3, hi = 1.5, flo = f(lo);
    if (flo * f(hi) >= 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
    }
    return (lo + hi) / 2;
  }

  raiz.MOTOR = { ESC, wacc, camino, dcf, valorar, sensibilidad, crecimientoImplicito, ronicImplicito, valorSinCrecimiento };
})(typeof window !== 'undefined' ? window : globalThis);

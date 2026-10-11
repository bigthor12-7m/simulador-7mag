// Añade al histórico semanal (app/datos/historico.json) la valoración con los supuestos del informe
// calculada con los datos de mercado de esta semana. Usa el mismo motor que la app (app/motor.js).
const fs = require('fs'), path = require('path');
require(path.join(__dirname, '..', 'app', 'motor.js'));
const dir = path.join(__dirname, '..', 'app', 'datos');
const L = (n, def) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n + '.json'), 'utf8')); } catch (e) { return def; } };
const emp = L('empresas'), tr = L('trayectorias'), mu = L('multiplos'), pa = L('parametros')[0], estado = L('estado', {});
const hist = L('historico', []);
const par = { rf: pa.tipo_sin_riesgo, erp: pa.prima_riesgo_mercado, spread: pa.diferencial_deuda, g: pa.crecimiento_perpetuo, dwacc: 0,
  prob: { pes: pa.prob_pesimista, base: pa.prob_base, opt: pa.prob_optimista }, pesoDcf: pa.peso_dcf, roicTope: pa.roic_tope,
  fr: { pes: pa.convergencia_roic_pesimista, base: pa.convergencia_roic_base, opt: pa.convergencia_roic_optimista }, metodoVt: 'inductores' };
const fecha = estado.fecha_mercado || pa.fecha_cotizacion;
const filas = emp.map((e) => {
  const t = e.ticker, tray = {};
  for (const sc of ['pes', 'base', 'opt']) {
    const rows = tr.filter((r) => r.ticker === t && r.escenario === sc).sort((a, b) => a.anio - b.anio);
    tray[sc] = { gr: rows.map((r) => r.crecimiento), mg: rows.map((r) => r.margen_ebit), da: rows.map((r) => r.amortizacion_ventas), cx: rows.map((r) => r.capex_ventas), nf: rows.map((r) => r.nof_ventas) };
  }
  const v = MOTOR.valorar(e, tray, mu.find((m) => m.ticker === t), par, {});
  return { fecha, ticker: t, cotizacion: e.cotizacion, valor_central: v.central, valor_bajo: v.bajo, valor_alto: v.alto, dcf_ponderado: v.pond,
    multiplos_media: v.mm, potencial: v.pot, wacc: v.w, tipo_sin_riesgo: par.rf };
});
const out = hist.filter((h) => h.fecha !== fecha).concat(filas).sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
fs.writeFileSync(path.join(dir, 'historico.json'), JSON.stringify(out, null, 0));
console.log(`Histórico: ${out.length} filas; semana ${fecha}:`, filas.map((f) => `${f.ticker} ${f.valor_central.toFixed(1)} (${(f.potencial * 100).toFixed(0)} %)`).join(' · '));

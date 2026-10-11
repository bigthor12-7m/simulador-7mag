#!/usr/bin/env python3
"""Actualización semanal de los datos del simulador de valoración de las 7 Magníficas.

Qué actualiza cada semana (Yahoo Finance):
  - cotizaciones y betas de las siete empresas;
  - tipo sin riesgo (Treasury a 10 años, ^TNX);
  - consenso de analistas de los años 1 y 2 (ventas y BPA mínimo, medio y máximo) -> trayectorias de los escenarios;
  - múltiplos adelantados de los comparables (PER y EV/EBITDA a doce meses) -> valor por múltiplos.

Qué NO cambia hasta la siguiente valoración completa (la que se hace con Claude cada trimestre): estados financieros,
último balance, acciones, hipótesis de largo plazo, prima de riesgo (Damodaran) y escenarios. Si una empresa ha
publicado resultados nuevos, el consenso de Yahoo pasa al trimestre siguiente y deja de encajar con el último balance
del modelo: entonces se conservan sus años 1-2 anteriores y se avisa de que hace falta la valoración completa.

Uso:
  python actualizar.py                    # descarga y escribe app/datos
  python actualizar.py --snapshot FECHA   # recalcula con una descarga guardada (prueba de que reproduce el modelo)
"""
import argparse, datetime as dt, json, pathlib, statistics as stt, sys, time

BASE = pathlib.Path(__file__).resolve().parent
DATOS = BASE.parent / "app" / "datos"
CONF = json.load(open(BASE / "configuracion.json", encoding="utf-8"))
MODULOS = "price,summaryDetail,defaultKeyStatistics,financialData,earningsTrend,calendarEvents"
r = lambda x: (x or {}).get("raw") if isinstance(x, dict) else x
d = lambda s: dt.date.fromisoformat(s)


# ======================================================================= descarga
def _cliente():
    """Devuelve una función get(url, params) -> JSON. Usa yfinance (gestiona cookies y 'crumb'); si no, requests."""
    try:
        from yfinance.data import YfData
        yd = YfData()
        return lambda url, params: yd.get_raw_json(url, params=params)
    except Exception as e:  # pragma: no cover
        print("yfinance no disponible, se usa requests:", e)
    import requests
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
    try: s.get("https://fc.yahoo.com", timeout=20)
    except Exception: pass
    crumb = s.get("https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=20).text.strip()
    def get(url, params):
        p = dict(params); p["crumb"] = crumb
        resp = s.get(url, params=p, timeout=30); resp.raise_for_status(); return resp.json()
    return get


def descargar(tickers):
    get = _cliente(); out, fallos = {}, []
    for t in tickers:
        for intento in range(4):
            try:
                j = get(f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{t}", {"modules": MODULOS})
                out[t] = j["quoteSummary"]["result"][0]
                break
            except Exception as e:
                if intento == 3: fallos.append(f"{t}: {e}")
                time.sleep(3 * (intento + 1))
        time.sleep(0.6)
    return out, fallos


# ======================================================================= consenso (misma lógica que consenso.py del modelo)
class Consenso:
    def __init__(self, yq, V, eurusd, estad=None):
        self.YQ, self.V, self.eurusd, self.estad = yq, V, eurusd, estad

    def trend(self, t):
        return {x["period"]: x for x in self.YQ[t]["earningsTrend"]["trend"]}

    def est(self, t, per, campo, k="avg"):
        e = self.trend(t).get(per)
        if not e: return None
        blk = e["earningsEstimate" if campo == "eps" else "revenueEstimate"]
        v = r(blk.get(k))
        if v is None: return None
        return v if campo == "eps" else v / 1e6

    def n_analistas(self, t, per, campo):
        e = self.trend(t).get(per)
        if not e: return None
        return r(e["earningsEstimate" if campo == "eps" else "revenueEstimate"].get("numberOfAnalysts"))

    # ---------------- años 1-2 del DCF
    def ebit_de_eps(self, t, eps, ventas, nq):
        c = CONF["empresas"][t]
        ebit = eps * c["acc"] / (1 - c["tax"]) - c["nfi_q"] * nq
        if c["sbc_nongaap"]: ebit -= c["ttm_sbc"] / c["ttm_rev"] * ventas
        return ebit

    def anio1(self, t, k):
        c = CONF["empresas"][t]
        v1y, e1y = self.est(t, "+1y", "rev", k), self.est(t, "+1y", "eps", k)
        if t == "MSFT":
            v0y, e0y = self.est(t, "0y", "rev", k), self.est(t, "0y", "eps", k)
            return v0y, self.ebit_de_eps(t, e0y, v0y, 4)
        if t == "AAPL":
            share = 102466 / 416161
            vq, eq_ = self.est(t, "0q", "rev", k), self.est(t, "0q", "eps", k)
            return vq + v1y * (1 - share), self.ebit_de_eps(t, eq_, vq, 1) + self.ebit_de_eps(t, e1y, v1y, 4) * (1 - share)
        s = c["ytd_rev"] / self.est(t, "0y", "rev", k)
        vq0, vq1 = self.est(t, "0q", "rev", k), self.est(t, "+1q", "rev", k)
        eq0, eq1 = self.est(t, "0q", "eps", k), self.est(t, "+1q", "eps", k)
        return (vq0 + vq1 + v1y * s,
                self.ebit_de_eps(t, eq0, vq0, 1) + self.ebit_de_eps(t, eq1, vq1, 1) + self.ebit_de_eps(t, e1y, v1y, 4) * s)

    def anclas(self, t):
        c = CONF["empresas"][t]; out = {}
        for k in ("avg", "low", "high"):
            va, ea = self.anio1(t, k)
            v1y, e1y = self.est(t, "+1y", "rev", k), self.est(t, "+1y", "eps", k)
            out[k] = {"g1": va / c["ttm_rev"] - 1, "m1": ea / va, "m2": self.ebit_de_eps(t, e1y, v1y, 4) / v1y}
        tr = self.trend(t); v0 = self.est(t, "0y", "rev", "avg")
        g_fy0 = v0 / (r(tr["0y"]["revenueEstimate"].get("yearAgoRevenue")) / 1e6) - 1
        g_fy1 = self.est(t, "+1y", "rev", "avg") / v0 - 1
        bal, E1 = d(c["fecha_balance"]), d(tr["+1y"]["endDate"])
        offset = max(0.0, ((bal + dt.timedelta(days=548)) - (E1 - dt.timedelta(days=182))).days / 365.25)
        decel = min(0.0, g_fy1 - g_fy0)
        out["avg"]["g2"] = g_fy1 + offset * decel
        out["low"]["g2"] = self.est(t, "+1y", "rev", "low") / v0 - 1 + offset * decel
        out["high"]["g2"] = self.est(t, "+1y", "rev", "high") / v0 - 1 + offset * decel
        return out

    def periodos(self, t):
        tr = self.trend(t)
        return {p: tr[p]["endDate"] for p in ("0q", "+1q", "0y", "+1y") if p in tr}

    # ---------------- múltiplos adelantados
    def ntm(self, t, campo):
        tr = self.trend(t); V = self.V
        if "0y" not in tr or "+1y" not in tr: return None
        f0, f1 = self.est(t, "0y", campo), self.est(t, "+1y", campo)
        if f0 is None or f1 is None: return None
        E0 = d(tr["0y"]["endDate"])
        if E0 <= V:
            if f0 <= 0 or f1 <= 0: return f1
            return f1 * (f1 / f0) ** ((V - E0).days / 365)
        rem = (E0 - V).days
        q0, q1 = tr.get("0q"), tr.get("+1q")
        q0e = d(q0["endDate"]) if q0 else None; q1e = d(q1["endDate"]) if q1 else None
        v0q, v1q = self.est(t, "0q", campo), self.est(t, "+1q", campo)
        if q1e == E0 and v1q is not None and (q0e < V or v0q is not None):
            stub = v0q * (q0e - V).days / 92 + v1q if q0e >= V else v1q * (q1e - V).days / (q1e - q0e).days
            return stub + f1 * (365 - rem) / 365
        if q0e == E0 and v0q is not None:
            return v0q * (q0e - V).days / 92 + f1 * (365 - rem) / 365
        return f0 * rem / 365 + f1 * (365 - rem) / 365

    def ev_ebitda_ttm(self, t):
        if self.estad is not None:
            return fnum((self.estad.get(t) or {}).get("Enterprise Value/EBITDA"))
        return r(self.YQ[t].get("defaultKeyStatistics", {}).get("enterpriseToEbitda"))

    def deuda_neta(self, t):
        if self.estad is not None:
            y = self.estad[t]; return (fnum(y["Enterprise Value"]) - fnum(y["Market Cap"])) * 1000
        y = self.YQ[t]
        return (r(y["defaultKeyStatistics"].get("enterpriseValue")) - r(y["price"].get("marketCap"))) / 1e6

    def fwd(self, t):
        y = self.YQ[t]; fd = y["financialData"]; pr = y["price"]
        px = r(pr.get("regularMarketPrice"))
        eps, rev = self.ntm(t, "eps"), self.ntm(t, "rev")
        tr = self.trend(t)
        cur = tr["+1y"]["earningsEstimate"].get("earningsCurrency") if "+1y" in tr else None
        if eps is not None and cur == "EUR": eps *= self.eurusd
        rev_ttm = (r(fd.get("totalRevenue")) or 0) / 1e6
        ratio = rev / rev_ttm if rev and rev_ttm else None
        n1 = self.n_analistas(t, "+1y", "eps") if "+1y" in tr else 0
        evt = self.ev_ebitda_ttm(t)
        per_f = px / eps if eps and eps > 0 else None
        if per_f and per_f > 200: per_f = None
        eve_f = evt / ratio if evt and ratio else None
        if ratio and not (0.7 <= ratio <= 2.5): eve_f = None
        if (n1 or 0) < 3: per_f = eve_f = None
        return {"px": px, "eps_ntm": eps, "ratio_ventas": ratio, "per_fwd": per_f, "ev_ebitda_fwd": eve_f, "n": n1,
                "ebitda_ttm": (r(fd.get("ebitda")) or 0) / 1e6}


def fnum(s):
    if s is None or s in ("--", ""): return None
    s = str(s).replace(",", "")
    mult = {"T": 1000.0, "B": 1.0, "M": 0.001, "k": 1000.0}
    return float(s[:-1]) * mult[s[-1]] if s[-1] in mult else float(s)


def lin(a, b, n=10):
    return [a + (b - a) * k / (n - 1) for k in range(n)]


# ======================================================================= cálculo de los ficheros de datos
def trayectorias_empresa(t, anc):
    c = CONF["empresas"][t]; lp = c["lp"]; filas = []
    for sc in ("pes", "base", "opt"):
        a = anc["avg"]
        if sc == "base": g1, g2, m1, m2, m10 = a["g1"], a["g2"], a["m1"], a["m2"], lp["m10"]
        elif sc == "pes":
            e = anc["low"]; g1, g2, m1, m2, m10 = e["g1"], e["g2"], min(e["m1"], a["m1"]), min(e["m2"], a["m2"]), c["m10_pes"]
        else:
            e = anc["high"]; g1, g2, m1, m2, m10 = e["g1"], e["g2"], max(e["m1"], a["m1"]), max(e["m2"], a["m2"]), c["m10_opt"]
        gr = [g1, g2] + [g2 + (lp["g10"] - g2) * j / 8 for j in range(1, 9)]
        mg = [m1, m2] + [m2 + (m10 - m2) * j / 8 for j in range(1, 9)]
        da, cx, nf = lin(*lp["da"]), lin(lp["cx0"], c["cx10"]), lin(*lp["nof"])
        for k in range(10):
            filas.append({"ticker": t, "escenario": sc, "anio": k + 1, "crecimiento": gr[k], "margen_ebit": mg[k],
                          "amortizacion_ventas": da[k], "capex_ventas": cx[k], "nof_ventas": nf[k]})
    return filas


def multiplos_empresa(t, cons, F):
    c = CONF["empresas"][t]; own = F[t]
    eps, ebitda_ntm, nd = own["eps_ntm"], own["ebitda_ttm"] * own["ratio_ventas"], cons.deuda_neta(t)
    fila = {"ticker": t, "bpa_ntm": eps}
    for key, nom, f in (("per_fwd", "per", lambda x: x * eps), ("ev_ebitda_fwd", "ev_ebitda", lambda x: (x * ebitda_ntm - nd) / c["acc"])):
        xs = [F[cp["tk"]][key] for cp in c["comparables"] if cp["tk"] in F and F[cp["tk"]][key] is not None]
        md, lo, hi = stt.median(xs), min(xs), max(xs)
        fila.update({f"{nom}_mediana": md, f"{nom}_valor_min": f(lo), f"{nom}_valor_mediana": f(md), f"{nom}_valor_max": f(hi)})
    fila["comparables"] = ", ".join(cp["tk"] for cp in c["comparables"])
    return {k: fila[k] for k in ("ticker", "bpa_ntm", "per_mediana", "ev_ebitda_mediana", "per_valor_min", "per_valor_mediana", "per_valor_max",
                                 "ev_ebitda_valor_min", "ev_ebitda_valor_mediana", "ev_ebitda_valor_max", "comparables")}


def leer(nombre):
    return json.load(open(DATOS / f"{nombre}.json", encoding="utf-8"))


def escribir(nombre, filas):
    json.dump(filas, open(DATOS / f"{nombre}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", help="fecha de una descarga guardada en actualizador/snapshot (prueba)")
    ap.add_argument("--salida", help="carpeta de salida (por defecto app/datos)")
    a = ap.parse_args()
    global DATOS
    origen = DATOS
    if a.salida: DATOS = pathlib.Path(a.salida); DATOS.mkdir(parents=True, exist_ok=True)
    orden = CONF["orden"]
    tickers = orden + CONF["comparables_tickers"]
    avisos, fallos = [], []
    if a.snapshot:
        yq = json.load(open(BASE / "snapshot" / f"yahoo_{a.snapshot}.json", encoding="utf-8"))
        estad = json.load(open(next((BASE / "snapshot").glob("yahoo_estadisticas_*.json")), encoding="utf-8"))
        V = dt.date(2026, 10, 9); tnx = 5.24; eurusd = CONF["eurusd_inicial"]; hoy = a.snapshot
    else:
        yq, fallos = descargar(tickers + ["^TNX", "EURUSD=X"])
        estad = None; hoy = dt.date.today().isoformat()
        tiempos = [r(yq[t]["price"].get("regularMarketTime")) for t in orden if t in yq]
        V = max(dt.datetime.fromtimestamp(x, dt.timezone.utc).date() for x in tiempos if x) if any(tiempos) else dt.date.today()
        tnx = r(yq.get("^TNX", {}).get("price", {}).get("regularMarketPrice"))
        eurusd = r(yq.get("EURUSD=X", {}).get("price", {}).get("regularMarketPrice")) or CONF["eurusd_inicial"]
    cons = Consenso(yq, V, eurusd, estad)

    prev = {n: json.load(open(origen / f"{n}.json", encoding="utf-8")) for n in ("empresas", "trayectorias", "multiplos", "parametros")}
    estado = {"actualizado": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes") if not a.snapshot else f"{hoy}T00:00+00:00",
              "fecha_mercado": V.isoformat(), "valoracion_completa": CONF["fecha_valoracion_completa"], "empresas": {}, "avisos": [], "fallos": fallos}

    # parámetros de mercado
    par = prev["parametros"][0]
    if tnx: par["tipo_sin_riesgo"] = round(tnx / 100, 4)
    else: avisos.append("No se pudo leer el Treasury a 10 años: se mantiene el tipo sin riesgo anterior.")
    par["fecha_cotizacion"] = V.isoformat()

    # empresas, consenso y trayectorias
    tray_prev = {}
    for f in prev["trayectorias"]: tray_prev.setdefault(f["ticker"], []).append(f)
    empresas, tray = [], []
    for e in prev["empresas"]:
        t = e["ticker"]; st = {"cotizacion": None, "consenso": "anterior", "proximos_resultados": None}
        if t in yq:
            y = yq[t]; px = r(y["price"].get("regularMarketPrice")); bb = y.get("summaryDetail", {}).get("beta")
            beta = float(bb["fmt"]) if isinstance(bb, dict) and bb.get("fmt") else r(bb)   # la beta que muestra Yahoo (2 decimales)
            if px: e["cotizacion"] = px; st["cotizacion"] = px
            if beta: e["beta"] = round(beta, 2)
            fechas = (y.get("calendarEvents", {}).get("earnings", {}) or {}).get("earningsDate") or []
            st["proximos_resultados"] = (fechas[0].get("fmt") if isinstance(fechas[0], dict) else None) if fechas else None
            try:
                if cons.periodos(t) == CONF["empresas"][t]["periodos"]:
                    tray += trayectorias_empresa(t, cons.anclas(t)); st["consenso"] = "actualizado"
                else:
                    tray += tray_prev[t]; st["consenso"] = "pendiente_valoracion_completa"
                    avisos.append(f"{e['nombre']} ha publicado resultados nuevos: sus años 1-2 siguen con el consenso de la última valoración completa hasta que se rehaga.")
            except Exception as ex:
                tray += tray_prev[t]; st["consenso"] = "error"; avisos.append(f"{e['nombre']}: no se pudo procesar el consenso ({ex}).")
        else:
            tray += tray_prev[t]; avisos.append(f"{e['nombre']}: sin datos de Yahoo esta semana; se mantienen los anteriores.")
        empresas.append(e); estado["empresas"][t] = st

    # múltiplos adelantados
    F = {}
    for t in tickers:
        if t in yq:
            try: F[t] = cons.fwd(t)
            except Exception as ex: avisos.append(f"{t}: múltiplo adelantado no disponible ({ex}).")
    mult = []
    mprev = {m["ticker"]: m for m in prev["multiplos"]}
    for t in orden:
        try: mult.append(multiplos_empresa(t, cons, F))
        except Exception as ex:
            mult.append(mprev[t]); avisos.append(f"{t}: se mantienen los múltiplos anteriores ({ex}).")

    estado["avisos"] = avisos
    escribir("empresas", empresas); escribir("trayectorias", tray); escribir("multiplos", mult); escribir("parametros", [par])
    json.dump(estado, open(DATOS / "estado.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"Datos de mercado del {V} · avisos: {len(avisos)} · fallos de descarga: {len(fallos)}")
    for x in avisos + fallos: print(" -", x)


if __name__ == "__main__":
    main()

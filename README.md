# Simulador 7M

App para valorar las 7 Magníficas (Apple, Microsoft, NVIDIA, Alphabet, Amazon, Meta y Tesla) con un DCF por escenarios y múltiplos de comparables. Todos los supuestos se pueden mover: tipo sin riesgo, prima de riesgo, WACC, crecimiento a perpetuidad, probabilidades de los escenarios, peso del DCF frente a los múltiplos y, por empresa, beta, crecimiento, margen y rentabilidad de la nueva inversión.

Se instala en el ordenador y en el móvil desde el navegador y funciona sin conexión con los últimos datos descargados.

## Instalarla

Abre la dirección de la app (GitHub Pages) y:

- **Windows o Mac, con Edge o Chrome:** botón **Instalar la app** de la propia página, o el icono de instalar en la barra de direcciones.
- **Android, con Chrome:** botón **Instalar la app**, o menú ⋮ → **Instalar aplicación**.
- **iPhone o iPad, con Safari:** botón **Compartir** → **Añadir a pantalla de inicio**.

## Cómo se actualiza

Cada lunes por la mañana, GitHub ejecuta el flujo **Actualizar datos** (`.github/workflows/actualizar.yml`), que:

1. descarga de Yahoo Finance las cotizaciones, las betas, el Treasury a 10 años, el consenso de analistas de las siete empresas y los datos de sus 24 comparables;
2. recalcula los años 1 y 2 de los tres escenarios y los múltiplos adelantados (`actualizador/actualizar.py`, con la misma lógica que el modelo del informe);
3. añade la semana al histórico con la valoración por defecto (`actualizador/historico.js`, con el mismo motor que la app);
4. guarda los datos en `app/datos/` y vuelve a publicar la app.

El EV/EBITDA de los comparables se toma del mismo dato que muestra la página *Statistics* de Yahoo (serie diaria de `fundamentals-timeseries`), igual que en la valoración completa; el campo `enterpriseToEbitda` de `quoteSummary` no se usa porque mezcla divisas en los ADR y usa otro EBITDA. Para revisar cada semana qué entra en las medianas, el flujo guarda `actualizador/ultimo_detalle.json` (múltiplos y fuente de cada comparable) y `actualizador/ultima_descarga.json` (descarga completa).

La app instalada recoge los datos nuevos la próxima vez que se abre con conexión. Para actualizar a mano: pestaña **Actions** → **Actualizar datos** → **Run workflow**.

Lo que **no** cambia cada semana son los estados financieros, el último balance, las acciones, las hipótesis de largo plazo, los escenarios y la prima de riesgo de Damodaran. Eso se rehace en la **valoración completa trimestral** con Claude (skill `analisis-financiero-v2`), que regenera `actualizador/configuracion.json` y los ficheros de `app/datos/`. Cuando una empresa publica resultados antes de esa valoración, el consenso de Yahoo pasa al trimestre siguiente: la app conserva sus años 1 y 2 anteriores y lo indica en los avisos.

## Comprobación

Con la descarga guardada del 10/10/2026, el actualizador reproduce exactamente los datos del informe:

```
python actualizador/actualizar.py --snapshot 2026-10-10 --salida /tmp/prueba
```

## Estructura

| Carpeta | Contenido |
|---|---|
| `app/` | La app que se publica: página, estilos, código (`app.js`), motor de valoración (`motor.js`), datos, iconos, fuentes y el *service worker* que la hace funcionar sin conexión |
| `app/datos/` | Datos de partida, proyecciones por escenario, múltiplos, resultados del informe, supuestos de mercado, histórico semanal y estado de la última actualización |
| `actualizador/` | Actualización semanal (Python y Node) y configuración fija del modelo |
| `.github/workflows/` | Actualización semanal y publicación en GitHub Pages |

## Fuentes y licencias

Datos: SEC EDGAR (estados financieros), Yahoo Finance (cotizaciones, consenso y múltiplos) y Damodaran Online (prima de riesgo, betas sectoriales y primas país). Fuentes tipográficas Inter y Lora (SIL Open Font License 1.1) y la librería d3 (ISC).

Herramienta con fines formativos: no constituye una recomendación de inversión.

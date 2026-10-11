// Simulador 7M · funcionamiento sin conexión.
// La app (HTML, código, fuentes, iconos) se guarda al instalarla; los datos se piden siempre a la red primero
// (para recibir la actualización semanal) y, sin conexión, se usan los últimos guardados.
const VERSION = 'app-1.0.0';
const APP = ['./', 'index.html', 'app.css', 'app.js', 'motor.js', 'vendor/d3.min.js', 'manifest.webmanifest',
  'fuentes/Inter-Regular.woff', 'fuentes/Inter-Medium.woff', 'fuentes/Inter-SemiBold.woff', 'fuentes/Lora-Regular.woff', 'fuentes/Lora-SemiBold.woff',
  'iconos/icono-192.png', 'iconos/icono-512.png', 'iconos/favicon-32.png', 'iconos/favicon-64.png', 'iconos/apple-touch-icon.png'];
const DATOS = 'datos-semanales';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== DATOS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/datos/')) {
    e.respondWith(
      fetch(e.request).then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(DATOS).then((c) => c.put(url.pathname, copia)); }
        return r;
      }).catch(() => caches.open(DATOS).then((c) => c.match(url.pathname)))
    );
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});

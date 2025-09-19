// Define o nome do cache
const CACHE_NAME = 'cantina-da-cleo-v1';
// Lista de arquivos essenciais para o app funcionar offline
const urlsToCache = [
  '/',
  '/index.html',
  '/acompanhar.html',
  '/style.css',
  '/logo.jpg',
  '/icon-192x192.png',
  '/icon-512x512.png'
];

// Evento de 'install': Roda quando o PWA é instalado
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache aberto');
        return cache.addAll(urlsToCache);
      })
  );
});

// Evento de 'fetch': Intercepta as requisições de rede
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Se o arquivo estiver no cache, usa o do cache.
        // Se não, busca na rede.
        return response || fetch(event.request);
      }
    )
  );
});
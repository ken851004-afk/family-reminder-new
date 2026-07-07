// Service Worker — 家庭提醒系統 Web Push
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(self.clients.claim());
});

// Push 推播事件（嚟自 GitHub Actions web-push server）
self.addEventListener('push', function(e) {
  var data = { title: '家庭提醒', body: '你有提醒事項', tag: 'reminder' };
  try {
    if (e.data) {
      var payload = e.data.json();
      data.title = payload.title || data.title;
      data.body = payload.body || data.body;
      data.tag = payload.tag || data.tag;
      data.url = payload.url || '/';
    }
  } catch (err) { /* keep default */ }

  var opts = {
    body: data.body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag,
    renotify: true,
    data: { url: data.url || '/' },
    requireInteraction: false,
    vibrate: [200, 100, 200]
  };

  e.waitUntil(self.registration.showNotification(data.title, opts));
});

// 撳通知 -> 打開頁面
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) ? e.notification.data.url : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      for (var i = 0; i < clients.length; i++) {
        if ('focus' in clients[i]) {
          clients[i].focus();
          if ('navigate' in clients[i]) clients[i].navigate(target);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

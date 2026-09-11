// 학급 수첩 알림용 서비스워커. 앱이 꺼져 있거나 백그라운드에 있을 때도 푸시 알림을
// 받으려면 이 파일이 사이트 루트(도메인 바로 아래)에 있어야 한다.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyB3Lg1SORQGZvz2gWUfFLParvkVbMQLguU",
  authDomain: "classmanager-share.firebaseapp.com",
  projectId: "classmanager-share",
  storageBucket: "classmanager-share.firebasestorage.app",
  messagingSenderId: "1025421381572",
  appId: "1:1025421381572:web:26c8dd7500d160900b5e91"
});

const messaging = firebase.messaging();

// 앱이 백그라운드에 있거나 완전히 닫혀 있을 때 도착한 알림을 처리한다.
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || '학급 수첩';
  const body = (payload.notification && payload.notification.body) || '';
  self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: payload.data || {},
  });
});

// Chrome이 "설치 가능한 앱"으로 인식하려면 서비스워커에 fetch 핸들러가 등록되어
// 있어야 한다(안드로이드에서 "앱 설치" 메뉴가 아예 안 뜨는 원인이었음). 동작은 그대로
// 두고(무조건 네트워크로 통과) 설치 조건만 충족시킨다.
self.addEventListener('fetch', () => {});

// 알림을 눌렀을 때 이미 열려있는 탭이 있으면 그걸 포커스하고, 없으면 새로 연다.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

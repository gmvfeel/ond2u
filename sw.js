/* 오늘도(OND2U) 서비스워커
 * 목적: "홈 화면에 설치" 조건을 충족시키기 위한 최소 구성.
 * 콘텐츠를 캐시하지 않으므로, 배포한 최신 화면이 항상 그대로 보입니다.
 * (캐시로 인해 "수정했는데 안 바뀐다" 하는 문제를 방지)
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// fetch 핸들러가 존재해야 설치 가능으로 인식됨.
// respondWith를 호출하지 않으면 브라우저가 평소처럼 네트워크에서 그대로 받아옴(=항상 최신).
self.addEventListener('fetch', () => { /* 네트워크 기본 동작 유지 */ });

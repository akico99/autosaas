(function(){
'use strict';

const POLICY_VERSION = 'connect-policy-1';

const DISCLOSURES = Object.freeze({
  travel: '이 포스팅은 네이버 여행 커넥트 활동의 일환으로, 예약 발생 시 수수료를 제공받습니다.',
  shopping: '이 포스팅은 네이버 쇼핑 커넥트 활동의 일환으로, 판매 발생 시 수수료를 제공받습니다.',
});

const CONNECT_KINDS = Object.freeze(Object.keys(DISCLOSURES));

function isConnectKind(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(DISCLOSURES, kind);
}

// 서비스 종류는 등록 때 사용자가 명시한 값만 쓴다. 제목·키워드·도메인으로 추정하지 않는다.
function getConnectDisclosure(connectKind) {
  if (!isConnectKind(connectKind)) throw new Error('알 수 없는 connectKind: ' + String(connectKind));
  return DISCLOSURES[connectKind];
}

// 앞뒤 공백만 제거한다. URL을 파싱해도 검증에만 쓰고 재직렬화한 값은 쓰지 않는다.
function validateAffiliateUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const fail = (reason) => ({ valid: false, raw: text, reason });
  if (!text) return fail('empty');
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return fail('contains-whitespace-or-control');
  if (!/^https?:\/\/[^/?#\\@]/i.test(text)) {
    if (!/^https?:/i.test(text)) return fail('unsupported-scheme');
    return fail('missing-host');
  }
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    return fail('unparseable');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('unsupported-scheme');
  if (!url.hostname) return fail('missing-host');
  if (url.username || url.password) return fail('credentials-not-allowed');
  return { valid: true, raw: text, reason: '' };
}

const connectPolicy = { POLICY_VERSION, CONNECT_KINDS, isConnectKind, getConnectDisclosure, validateAffiliateUrl };
if (typeof module !== 'undefined' && module.exports) module.exports = connectPolicy;
if (typeof window !== 'undefined') window.connectPolicy = connectPolicy;
})();

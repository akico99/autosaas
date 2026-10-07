'use strict';

const { saju } = require('./saju');

const mujusky = {
  id: 'mujusky',
  label: '무주스키샵',
  enabled: false,
  siteUrl: 'https://www.mujusky.co.kr',
  domains: ['mujusky.co.kr'],
};

// 여행 Connect는 기존 주제 저장소의 프로필·사진·성과 경로를 재사용한다.
// 상품 근거와 생성 맥락은 main process가 catalog에서 따로 구성한다.
const travelConnect = {
  id: 'travel-connect',
  label: '여행 상품 정보',
  enabled: true,
  siteUrl: 'https://example.invalid',
  domains: [],
  products: [],
  keywordPlan: [],
};

const TOPICS = { saju, mujusky, 'travel-connect': travelConnect };

module.exports = { TOPICS, saju, mujusky, travelConnect };

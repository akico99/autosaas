// 프리로드 — 렌더러(UI)에 "안전한 통로"만 노출한다.
// contextIsolation 상태에서 window.api 로 메인 프로세스 기능을 부른다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 키워드 자동 수집(자동완성 확장 + 빈틈 점수)
  keywordRadar: (seed, useAction) =>
    ipcRenderer.invoke('keyword:radar', { seed, useAction }),
  // 공식 검색광고 XLSX 선택 → 자동완성 병합 → 키워드 미리보기 생성
  keywordReportPrepare: (options) => ipcRenderer.invoke('keyword-report:prepare', options || {}),
  // 메인 프로세스에 준비된 결과를 저장 다이얼로그로 XLSX 내보내기
  keywordReportExport: (options) => ipcRenderer.invoke('keyword-report:export', options || {}),
  // 크리에이터 어드바이저 트렌드 키워드(선택한 유형의 주제로 필터, 네이버 로그인 세션으로 수집)
  advisorTrends: (type) => ipcRenderer.invoke('advisor:trends', { type }),
  // 실제 글 생성(홈판용) — 구독 인증
  generatePost: (type, keyword, tone, style, extras) =>
    ipcRenderer.invoke('generate:post', { type, keyword, tone, style, ...(extras || {}) }),
  generateTopic: (request) => ipcRenderer.invoke('generate:topic', request || {}),
  connectCatalog: () => ipcRenderer.invoke('connect:catalog', {}),
  connectImportProduct: (request) => ipcRenderer.invoke('connect:importProduct', request || {}),
  connectAutoImport: (request) => ipcRenderer.invoke('connect:autoImport', request || {}),
  connectRefreshProduct: (request) => ipcRenderer.invoke('connect:refreshProduct', request || {}),
  connectSaveProduct: (request) => ipcRenderer.invoke('connect:saveProduct', request || {}),
  connectPrepareKeywords: (request) => ipcRenderer.invoke('connect:prepareKeywords', request || {}),
  connectPrepareDelivery: (request) => ipcRenderer.invoke('connect:prepareDelivery', request || {}),
  quickAnalyze: (request) => ipcRenderer.invoke('quick:analyze', request || {}),
  quickGenerate: (request) => ipcRenderer.invoke('quick:generate', request || {}),
  quickMarkSaved: (draftId) => ipcRenderer.invoke('quick:markSaved', { draftId }),
  // 원고 보관함 — 미리 생성·불러오기·수정·삭제·에디터 넣기 표시
  topicDraftsList: (topicId) => ipcRenderer.invoke('topicDrafts:list', topicId || 'saju'),
  topicDraftsGenerate: (request) => ipcRenderer.invoke('topicDrafts:generate', request || {}),
  topicDraftsCancel: () => ipcRenderer.invoke('topicDrafts:cancel'),
  topicDraftsImport: (request) => ipcRenderer.invoke('topicDrafts:import', request || {}),
  topicDraftsUpdate: (id, text) => ipcRenderer.invoke('topicDrafts:update', { id, text }),
  topicDraftsDelete: (id) => ipcRenderer.invoke('topicDrafts:delete', { id }),
  topicDraftsMarkInjected: (id) => ipcRenderer.invoke('topicDrafts:markInjected', { id }),
  onTopicDraftsProgress: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('topicDrafts:progress', listener);
    return () => ipcRenderer.removeListener('topicDrafts:progress', listener);
  },
  topicConfig: (topicId) => ipcRenderer.invoke('topic:config', topicId || 'saju'),
  topicProfilesGet: (topicId) => ipcRenderer.invoke('topicProfiles:get', topicId || 'saju'),
  topicProfilesSave: (profiles) => ipcRenderer.invoke('topicProfiles:save', profiles || []),
  topicAssetsList: (topicId) => ipcRenderer.invoke('topicAssets:list', topicId || 'saju'),
  topicAssetsCapture: (topicId) => ipcRenderer.invoke('topicAssets:capture', topicId || 'saju'),
  topicAssetsAddCustom: (options) => ipcRenderer.invoke('topicAssets:addCustom', options || {}),
  topicPerformance: (topicId) => ipcRenderer.invoke('topic:performance', topicId || 'saju'),
  topicSerpAnalyze: (topicId) => ipcRenderer.invoke('topic:serpAnalyze', topicId || 'saju'),
  // 검색용 — 주제 목록 + 생성
  searchTopics: () => ipcRenderer.invoke('search:topics'),
  generateSearch: (topic, keyword, extra, style, memo, paid, commerce, source, persona, avoidKeywords, review, opts) => ipcRenderer.invoke('generate:search', { topic, keyword, extra, style, memo, paid, commerce, source, persona, avoidKeywords, review, opts }),
  perfList: () => ipcRenderer.invoke('perf:list'),
  perfSync: (blogId, topicId) => ipcRenderer.invoke('perf:sync', { blogId, topicId }),
  perfLink: (id, url) => ipcRenderer.invoke('perf:link', { id, url }),
  perfRecordViews: (id, views) => ipcRenderer.invoke('perf:recordViews', { id, views }),
  perfCheck: (topicId) => ipcRenderer.invoke('perf:check', { topicId }),
  getSearchRecent: () => ipcRenderer.invoke('searchRecent:get'),
  addSearchRecent: (keyword) => ipcRenderer.invoke('searchRecent:add', { keyword }),
  keywordUrlBackfill: (opts) => ipcRenderer.invoke('keyword:urlBackfill', opts || {}),
  autopostNextStrategy: () => ipcRenderer.invoke('autopost:nextStrategy'),
  addTitle: (title, kind, titleOk) => ipcRenderer.invoke('titles:add', { title, kind, titleOk }),
  getTodayTitles: () => ipcRenderer.invoke('titles:today'),
  // ★예약 위임 — 앱이 켜져 있을 때 예약(--auto)이 뜨면 main이 실행 중인 창에 'run-auto'를 보낸다 → autoRun 실행.
  onRunAuto: (cb) => ipcRenderer.on('run-auto', (_e, data) => { try { cb(data || {}); } catch (e) {} }),
  collectLinkImages: (images, siteName, isGov) => ipcRenderer.invoke('image:collectLink', { images, siteName, isGov }),
  advisorSearchTopic: (label) => ipcRenderer.invoke('advisor:searchTopic', { label }),
  // 사진 불러오기(네이티브 파일 창)
  pickImages: () => ipcRenderer.invoke('image:pick'),
  // 자동 로그인 유지 여부
  setAutoLogin: (keep) => ipcRenderer.invoke('session:autologin', keep),
  // 네이버 로그아웃(naver.com 쿠키만 삭제) — 다른 네이버 아이디로 재로그인용. 클로드는 유지.
  logoutNaver: () => ipcRenderer.invoke('session:logoutNaver'),
  // 클로드 로그인(구독 계정) — 상태확인 / 로그인시작 / 코드확인
  claudeStatus: () => ipcRenderer.invoke('claude:status'),
  claudeLogin: (email) => ipcRenderer.invoke('claude:login', { email }),
  claudeLoginCode: (code) => ipcRenderer.invoke('claude:loginCode', { code }),
  claudeLogout: () => ipcRenderer.invoke('claude:logout'),
  // 이미 로그인돼 있는지 확인
  checkSession: () => ipcRenderer.invoke('session:check'),
  debugLog: (msg) => ipcRenderer.invoke('debug:log', msg),
  // 진단 덤프(에디터 주입·caret 프로브 등)를 userData 파일로 저장
  saveDebug: (name, text) => ipcRenderer.invoke('debug:saveText', { name, text }),
  saveResvSettings: (s, kind) => ipcRenderer.invoke('schedule:saveSettings', { kind: kind || 'home', settings: s }),
  getResvSettings: (kind) => ipcRenderer.invoke('schedule:getSettings', { kind: kind || 'home' }),
  saveProfile: (profile) => ipcRenderer.invoke('profile:save', { profile }),
  getProfile: () => ipcRenderer.invoke('profile:get'),
  // 에디터에 텍스트 붙여넣기(클립보드+Cmd/Ctrl+V) — 스마트에디터 자동 주입
  editorPaste: (wcId, text, html) => ipcRenderer.invoke('editor:paste', { wcId, text, html }),
  // 에디터 본문 전체 선택(폰트 적용 전) — 포커스된 편집칸에 selectAll
  editorSelectAll: (wcId) => ipcRenderer.invoke('editor:selectAll', { wcId }),
  editorSendKey: (wcId, keys) => ipcRenderer.invoke('editor:sendKey', { wcId, keys }),
  editorCaretEnd: (wcId) => ipcRenderer.invoke('editor:caretEnd', { wcId }),
  editorFocusParaByText: (wcId, text) => ipcRenderer.invoke('editor:focusParaByText', { wcId, text }),
  editorRemoveParaByText: (wcId, text) => ipcRenderer.invoke('editor:removeParaByText', { wcId, text }),
  editorInsertText: (wcId, text) => ipcRenderer.invoke('editor:insertText', { wcId, text }),
  focusWindow: () => ipcRenderer.invoke('win:focus'),
  editorClickAt: (wcId, x, y) => ipcRenderer.invoke('editor:clickAt', { wcId, x, y }),
  // 뉴스 기사 이미지 수집(최신·정확·출처) — 로컬 다운로드 후 경로 반환
  collectNewsImages: (keyword, opts) => ipcRenderer.invoke('image:collectNews', { keyword, ...(opts || {}) }),
  // ★이미지 검색 수집(과거 사진 포함) — Claude가 만든 정확한 검색어로.
  collectImages: (query, opts) => ipcRenderer.invoke('image:collect', { query, ...(opts || {}) }),
  // ★영화 전용 — "작품명 포토" 네이버 영화카드의 공식 스틸컷·포스터·프로모션(딴 동명영화 안 섞임)
  collectMoviePhotos: (title, opts) => ipcRenderer.invoke('image:collectMovie', { title, ...(opts || {}) }),
  // ★정책·정부 전용 — AI브리핑 인용 공식 사이트의 이미지(없으면 페이지 캡쳐). urls = generate 결과의 officialUrls
  collectOfficialImages: (urls) => ipcRenderer.invoke('image:collectOfficial', { urls }),
  // ★기사 자체 이미지(+캡션) — 무조건 관련 + 캡션으로 정밀 관련성
  collectArticleImages: (keyword, opts) => ipcRenderer.invoke('image:articleImages', { keyword, ...(opts || {}) }),
  visionFilterImages: (images, ctx) => ipcRenderer.invoke('image:visionFilter', { images, ...(ctx || {}) }), // ctx.photoOnly=true면 그래픽 거절·실사만
  // 내 블로그 최근 글 목록("함께 보면 좋은 글" 내부순환 후보)
  myBlogPosts: (blogId) => ipcRenderer.invoke('blog:myPosts', { blogId }),
  // URL(쿠팡 등)에서 제품명 가져오기(제목에 넣기 위해 생성 전 호출)
  productName: (url) => ipcRenderer.invoke('link:productName', { url }),
  // ★링크형 — URL에서 제목·본문·이미지·출처 추출
  linkExtract: (url) => ipcRenderer.invoke('link:extract', { url }),
  // 예약 자동 실행 — 끝나면 종료 요청 / 자동모드 여부
  autoDone: (log) => ipcRenderer.invoke('app:autoDone', { log }),
  isAuto: () => ipcRenderer.invoke('app:isAuto'),
  // 예약 자동 발행 — OS 스케줄러 등록/해제/상태
  scheduleEnable: (opts) => ipcRenderer.invoke('schedule:enable', opts || {}),
  scheduleDisable: (kind) => ipcRenderer.invoke('schedule:disable', { kind: kind || 'home' }),
  scheduleStatus: (kind) => ipcRenderer.invoke('schedule:status', { kind: kind || 'home' }),
  classifyMyPhotos: (photos, slots, subject) => ipcRenderer.invoke('image:classifyMine', { photos, slots, subject }),
  // 로컬 이미지 파일 → data URL(썸네일 미리보기용)
  imageDataUrl: (path) => ipcRenderer.invoke('image:dataUrl', { path }),
  // 편집기 카드 SVG → PNG(파일 경로) — ③[넣기]용
  svgToPng: (svg, index) => ipcRenderer.invoke('thumbnail:svgToPng', { svg, index }),
  openExternal: (url) => ipcRenderer.invoke('open:external', { url }),
  // 썸네일 자동 제작(1:1 텍스트카드 PNG) → 파일 경로 반환
  renderThumbnails: (items) => ipcRenderer.invoke('thumbnail:render', { items }),
  // 에디터에 실제 이미지 삽입(CDP file input 주입). opts.inline=true면 "📷 사진 자리" 위치에 인라인 배치.
  editorInsertImages: (wcId, files, opts) => ipcRenderer.invoke('editor:insertImages', { wcId, files, ...(opts || {}) }),
});

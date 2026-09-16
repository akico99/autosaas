// 홈판 콘텐츠 유형 13종 (naver-homefeed-writing-logic + homefeed-operation-logic 메모리, 실물 15개 블로그 분석 결과).
// ★2026-08-02 재구성(사용자): 연예 가십 최상단 / 앱테크+테크뉴스 → IT·컴퓨터 병합 / 리뷰(내 사진) 신규 / 라이프SEO → 요리·레시피 개명.
//
// 각 유형 필드:
//  - style: 'poem'(한 문장=한 문단 중앙정렬) / 'prose'(좌측정렬 산문+정보표)
//  - subhead/hook/quoteStyle: 소제목·도입훅·인용구 스타일(실물 분석)
//  - thumbnail: 'ours'(우리 썸네일 생성기, 전 유형 공통)
//  - bodyImage: IMAGE_POLICY 키 (본문 이미지 정책)
//  - links: 'none'(홈판·내부순환만) / 'internal'(끝 내 og카드) / 'affiliate'(제휴+고지문)
//  - advisorTopics: ★네이버 크리에이터 어드바이저 "주제별 인기유입검색어"의 주제 라벨(정확히 일치해야 필터됨).
//                   빈 배열 = 어드바이저 트렌드 안 씀(리뷰=내 사진 전용).
//  - myPhotoOnly: true = 내가 올린 사진으로만(리뷰형). linkRead: true = 사용자가 준 링크를 읽어 후기 작성(쿠파스).
//  - length = 본문 텍스트 목표 글자수.
const POST_TYPES = {
  celebrity: {
    label: '연예 가십·이슈형',
    style: 'poem',
    links: 'internal',
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'postit',
    quoteStyle: 'bubble',
    thumbnail: 'ours',
    bodyImage: 'celeb',
    advisorTopics: ['패션·미용', '스타·연예인', '영화', '방송', '드라마'],
    description:
      '먼저 "최근 왜 떴는지"(작품·화보·열애·이혼·근황)를 파악해 그 각도로. 어그로 무기 = 과거(졸업·어릴적·과거 체형) vs 현재 대비, 감량 수치("○kg 뺐다"), 이혼·열애("재벌가와 결혼했다 이혼", "○○의 연인"), 투병 극복, 패션 아이콘, 놀라운 근황. 이름 감춤("이 여배우")·…말줄임 궁금증. 확인 안 된 성형·시술·사생활은 완곡/의문형(명예훼손 회피), 이혼·투병처럼 공개된 사실은 그대로. 이미지 출처 캡션 철저.',
  },
  restaurant: {
    label: '맛집·장소형',
    style: 'prose',
    links: 'none', // 홈판형: 네이버 지도(placeId) 블록만 허용
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'titleQuote',
    quoteStyle: 'line',
    thumbnail: 'ours',
    bodyImage: 'myphoto', // 내 사진 多(세로형) + imageStrip 2장나란히
    advisorTopics: ['맛집'],
    description:
      '내 실사진 + 네이버 지도(placeId) + 인용구 소제목 + 이모지 정보블록(📍주소 ✅좌석 ⏰운영시간 🍽메뉴 ⭐맛평가) + 방문기(대기·오픈런) + 해시태그. 트렌드 훅(방송 계기). 별점·가벼운 아쉬움 허용.',
  },
  travel: {
    label: '여행형',
    style: 'prose',
    links: 'none',
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'titleQuote',
    quoteStyle: 'line',
    thumbnail: 'ours',
    bodyImage: 'myphoto', // 실사진 콜라주(imageStrip)
    advisorTopics: ['국내여행', '세계여행'],
    description:
      '실사진 콜라주(imageStrip) + 정보표(주소/영업시간/입장권) + 지도 + 번호 섹션(01 가는길 02 공간이야기). 외부 링크 없이 본문으로 완결.',
  },
  review: {
    label: '리뷰형(내 경험·체험단)',
    style: 'prose',
    links: 'none',
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'titleQuote',
    quoteStyle: 'line',
    thumbnail: 'ours',
    bodyImage: 'myphoto',
    advisorTopics: [], // ★어드바이저 트렌드 안 씀 — 내가 직접 겪은 것을 내 사진으로.
    myPhotoOnly: true,
    description:
      '★내가 직접 경험한 것(체험단·내돈내산·방문·사용)을 내 사진으로 쓰는 실제 후기. 대상=맛집·장소·여행·제품·서비스 무엇이든. Claude가 사진을 보고(비전) 그 장면을 묘사·후기화. 구성: 왜 갔나/받았나(계기) → 첫인상 → 항목별 상세(맛·분위기·사용감·가격) → 좋았던 점 강조 → 소소한 팁 → 총평·추천. ★항상 긍정 톤(체험단), 별점 없음, 아쉬운 점은 짧게+"그래도 좋았다". 사진에 없는 정보(주소·가격 등)는 지어내지 않고 사용자 입력만. 장소면 지도(placeId) 첨부.',
  },
  invest: {
    label: '금융·투자(주식)형',
    style: 'prose',
    links: 'none',
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'postit',
    quoteStyle: 'underline',
    thumbnail: 'ours',
    bodyImage: 'news', // 주가 차트·수익 인증 캡처 여러 장
    advisorTopics: ['비즈니스·경제'],
    description:
      '주가 차트·종목 비교표 + 1인칭 스토리텔링 가능. 정보와 개인의견 구분, 투자권유 아님 면책 문구(hr 아래) 필수. 참고 출처는 기관명 텍스트로.',
  },
  policy: {
    label: '정책·지원금형',
    style: 'prose',
    links: 'none', // 홈판 정책은 기관명 텍스트로
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'toc',
    quoteStyle: 'line',
    thumbnail: 'ours',
    bodyImage: 'news', // ★여러 장 필요. 정부사이트(korea.kr 등) 검색해 정확히 수집
    advisorTopics: ['사회·정치', '비즈니스·경제'],
    description:
      '표(지원 대상·자격·금액·신청방법·신청기간) + Q&A(FAQ) 필수. 손실회피("놓치면 손해") 강조. 참고 출처는 기관명 텍스트로.',
  },
  it: {
    label: 'IT·컴퓨터·테크형',
    style: 'prose',
    links: 'none',
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'titleQuote',
    quoteStyle: 'line',
    thumbnail: 'ours',
    bodyImage: 'news', // 제품·앱 이벤트 스크린샷·유출컷 여러 장
    advisorTopics: ['IT·컴퓨터', '게임'],
    description:
      '★앱테크·혜택 + 테크 제품뉴스 통합. 앱 이벤트/보상("매일 최대 N원" 손실회피)·신제품 출시/스펙/유출/사전예약. 날짜 명시(최신성) + 혜택·스펙 표 + 번호 섹션 + 댓글 유도. 확정 안 된 스펙·가격은 "유출/루머"로 표기.',
  },
  car: {
    label: '자동차·신차형',
    style: 'prose',
    links: 'none',
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'titleQuote',
    quoteStyle: 'line',
    thumbnail: 'ours',
    bodyImage: 'news', // 차량 사진(정면·후면·실내·유출컷) 여러 장
    advisorTopics: ['자동차'],
    description:
      '신차·유출·실물등장·판매량·논란/리콜 트렌드 훅. 소제목마다 차량 사진 + 스펙/경쟁차 비교표 + 인용구 강조박스. 전기차면 보조금·실구매가 필수. 제목=비교·반전·발견.',
  },
  sportsnews: {
    label: '스포츠형',
    style: 'prose',
    links: 'internal', // 끝 "함께 보면 좋은 글" 내 og카드 3개
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'postit',
    quoteStyle: 'postit',
    thumbnail: 'ours',
    bodyImage: 'news', // OSEN·유튜브·인스타 캡처 + 출처 캡션 필수
    advisorTopics: ['스포츠', '게임'],
    description:
      '감탄사+연속 물음표+반전 제목 + 기사체 본문 + 소식통 인용 + se-material(팀 카드) + 근거 나열+"확인 안 됨" 반복(명예훼손 방어) + 이미지 출처 캡션 필수.',
  },
  life: {
    label: '생활·건강·요리형',
    style: 'prose',
    links: 'internal',
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'titleQuote',
    quoteStyle: 'underline',
    thumbnail: 'ours',
    bodyImage: 'mixed',
    advisorTopics: ['취미', '육아·결혼', '요리·레시피', '건강·의학', '교육·학문', '인테리어·DIY', '문학·책', '공연·전시'],
    description:
      '★건강·육아 + 요리·레시피 + 생활정보(폭염·한파·계절·팝업스토어·마트행사·전시·나들이 등) 통합. 건강=원인·증상·구분·관리(단정 진단 금지, 완곡·의문형) / 요리=재료·분량 표+과정 번호섹션+완성사진 / 생활정보=계절·날씨·꿀팁. 1인칭 경험 가능, 신뢰 출처는 기관명 텍스트.',
  },
  coupang: {
    label: '쿠파스·커머스형',
    style: 'prose',
    links: 'affiliate', // 제휴 링크가 핵심 → 고지문과 함께 링크 허용
    length: { min: 1500, label: '1,800~2,500자' },
    subhead: 'quoteLine',
    hook: 'titleQuote',
    quoteStyle: 'line',
    thumbnail: 'ours',
    bodyImage: 'product', // 상품 이미지(og카드) + 비교표
    advisorTopics: ['상품리뷰'],
    linkRead: true, // ★사용자가 준 상품 링크를 읽어 실제 후기로 작성
    description:
      '쿠팡파트너스 고지문 맨 위 빨간 볼드 필수. 상품 링크는 사용자가 직접 제공 → 그 링크(상품 페이지·후기)를 읽고 실제 후기로 작성. 제품별 소제목 + 컬러 볼드 라벨 불릿 + 비교표 + 링크(제품마다). ★자동발행 불가(링크는 사람이 직접 선택).',
  },
};

// ★본문 이미지 정책 (실제 수집은 3단계 이미지소싱이 이 키를 읽어 동작)
const IMAGE_POLICY = {
  myphoto:
    '사용자가 올린 실사진 위주(리뷰·여행형). 세로형 多 + imageStrip(2장 나란히) 활용.',
  celeb:
    '결혼식·화보·어그로성 이미지(다 보여주지도 덜 보여주지도 않는 궁금증 유발). 인스타 당사자 셀카 우선. 출처 캡션 필수, 성형은 의문형.',
  news:
    '★여러 장 필요(1장 X). 뉴스 캡처 + 해당 주제 정부/공식 사이트(korea.kr·dataq.or.kr 등)를 검색해 관련성 있게 정확히 수집. 아무 이미지 X. 출처 캡션.',
  product: '상품 이미지 og카드 + 비교표(쿠파스·커머스형).',
  ours: '우리 썸네일 생성기로 카드형 이미지 제작(실사진 없거나 카드 본문형).',
  mixed: '실사진 + 검색 이미지 + 우리 그래픽 혼합.',
};

// ★홈판 공통 규칙 (모든 유형 프롬프트에 자동 주입) — homefeed-operation-logic 메모리 기반
const HOMEFEED_RULES = [
  '제목 = 발견형(반전·숫자·따옴표·…말줄임·의외성). 검색 키워드 나열 X.',
  '첫 문장에서 궁금증·긴장으로 잡아라(뒤로가기=노출 끊김).',
  '문단은 모바일 기준으로 짧게 나눈다(PC 아님). 한 text 블록 = 2~4문장, 한 가지 이야기만. 주제가 바뀌면 새 text 블록으로 나눈다(문단 사이 빈 줄로 숨통).',
  '★★모든 문장은 "완결된 자연스러운 구어체 한국어"로. ①문장을 중간에 끊거나 조각내지 마라(주어·서술어 갖춘 온전한 문장). ②어색한 문어체·과한 표현 금지("소위", "~라는 것이다", "~에 다름 아니다"). ③맞춤법·띄어쓰기 정확히. ④갑작스러운 전환 금지("자, 여기가 제일 중요해요" 식으로 툭 튀지 말고 자연스럽게 이어라). ⑤한 문단 안에서도 앞뒤 문장이 매끄럽게 연결되게.',
  '★Q&A(qna)는 각 질문-답을 "별도 문단"으로 명확히 구분한다(질문끼리 다닥다닥 붙이지 말 것).',
  '대표 썸네일은 우리 생성기(1:1 정사각) — 클릭률 결정.',
  '본문 이미지 5~10장, 유사·중복 금지, 출처 캡션.',
  '소제목은 인용구 버티컬라인으로. 따옴표 인용구(quote)는 초반 1~2개만(최대 2개), 과용 금지.',
  '글 끝에 독자 행동 유도 1개(저장·공유·댓글 중 하나 — 유저 프롬프트에서 지정, 셋 다 넣지 말 것).',
  '★★같은 정보·문장·표현을 여러 소제목/문단에서 반복하지 마라(예: "쿠키는 1개"·"끝까지 앉아라"를 섹션마다 되풀이 금지). 각 섹션은 서로 다른 새 정보·각도로 채운다(한 번 말한 사실은 다시 안 쓴다). 마무리에서 요약할 때도 앞 문장을 그대로 복붙하지 말고 짧게 새로 쓴다.',
  '★★표(table) 블록 절대 금지 — 비교·스펙·수치·정보표는 전부 문장이나 불릿(✓)으로 풀어써라. (표는 검색용 전용, 홈판에는 어떤 유형도 표를 넣지 않는다.)',
  '★소제목(heading)은 최소 4개 이상 만든다(글을 4개 이상 섹션으로 나눠 스캔·가독성↑). 각 heading 뒤엔 반드시 설명 text가 온다.',
  '★★소제목(heading)도 "짧고 궁금증형"으로 써라 — 장황한 설명형("○○은 어떤 사람일까요", "○○에 대해 알아보겠습니다", "~살펴보겠습니다", "~정리해보았습니다")은 금지. "노을 강균성은 누구?", "14살 나이차, 괜찮을까?", "혼전순결 서약의 진실은?", "신부 정체는?"처럼 명사·질문으로 툭툭 끊어 궁금하게. (연예·이슈는 특히 짧고 후킹있게)',
  '★blocks는 절대 heading(소제목)으로 끝나지 않는다. 모든 heading 바로 뒤에는 그 내용을 설명하는 text가 반드시 온다(빈 섹션·미완성 금지). 마지막 블록은 마무리 text다.',
  '반응신호 무게: 체류·공유 > 댓글·좋아요 > 단순클릭. 낚시(CTR만 높고 체류 짧음) 금지.',
  '성형·시술 등 단정은 완곡·의문형. 논란·정치는 담백하게.',
  '★★★★[맥락 없는 이름·단어 = "지금 왜 떴는지" 하나에 집중, 동명이인 나열 금지] 키워드가 흔한 이름·짧은 단어(예: "김민수")처럼 여러 사람·여러 뜻이 겹치면 — ★"동명이인 총정리"·"여러 뜻 정리"로 쓰지 마라. 배경조사(최신 뉴스)에서 "지금 이게 검색되는 진짜 이유"(무슨 사건·발언·이슈로 떴는지)를 딱 하나 파악해 ★그 맥락 하나에만 집중해 써라(제목·이미지·소제목·대표사진 전부 그 하나로 통일). 예: "김민수"가 "국민의힘 김민수 최고위원 발언 논란"으로 떴으면 그것만 다루고 다른 동명이인(가수·보디빌더 등)은 넣지 마라. 배경에서 확실치 않으면 최신 뉴스에 가장 많이 나온 그 하나를 택한다.',
  '★★★★[인물 글 = "누구인가"는 반드시 밝히되, 확인 안 된 과거이력만 방어] ①사람들이 인물을 검색하는 이유 = "이 사람이 누구인지"다 → 현재 직업·직함·소속 + 왜 이 사건에 등장하는지를 반드시 밝혀라(역할로만 부르고 신상을 생략하면 실패). 신상은 사건과 함께 확인되는 확실한 것(예: ○○ 대표·사업가)으로. ②단 "과거 이력·직업"(치어리더 등)은 이 사건 맥락과 이어지고 확실할 때만 — 이름만으로 나온 과거직업을 단정 금지(동명이인일 수 있음). 원칙: "확실한 현재 신상은 밝히고, 확인 안 된 과거이력만 뺀다."',
  '★★★[이미지 지시어를 본문·소제목에 쓰지 마라] searchQuery·imageHint(예: "국민의힘 로고")는 사진 찾는 지시일 뿐 — heading(소제목)이나 text(본문)에 "○○ 로고", "○○ 로고 — 소속 확인", "사진 설명을 입력하세요" 같은 이미지 지시·자리표시 문구를 절대 쓰지 마라. 소제목은 그 섹션 "내용 제목"으로만.',
  '★★★[같은 로고·같은 사진 두 번 금지] 같은 대상의 로고를 두 번 넣지 마라. 로고를 한 장 썼으면 추가 image는 "다른 사진"(인물·현장 실사, 로고 다른 버전=간판·CI, 관련 소재)으로 — image마다 searchQuery를 서로 다른 대상으로 잡아 같은 이미지가 반복되지 않게.',
  '★★★[무명 인물 = 대표사진 대체 순서] 주인공이 얼굴 안 알려진 무명 인물이면: ①먼저 그 사람 사진을 이름+직함/맥락으로 최대한 찾고 ②사진이 애매하면 그 사람 "회사·소속·브랜드 로고"(예: "이너핑크 로고", "구스타 로고")를 찾아 넣어도 됨 ③그것도 없으면 이 사건에 함께 나오는 "유명 인물"(사건 관계자) 사진 ④그마저 없으면 사건 현장·기관·중립 이미지(정당 로고·국회·검찰청·소관 부처 로고)로. ★이 사건과 무관한 엉뚱한 사람·짤은 대표 금지(반드시 사건 관계자/관련 로고).',
].join('\n');

// ★인용구(quote=66/99 따옴표 블록) 하드 규칙: 글당 최대 2개 (사용자 요청 — 초반에 1~2개만, 과용 금지). 소제목 버티컬라인과는 별개.
const MAX_QUOTES = 2;

// ★유형 → 어드바이저 주제 매핑(수집기가 이 주제의 인기유입검색어를 가져온다).
const ADVISOR_TOPIC_BY_TYPE = Object.fromEntries(
  Object.entries(POST_TYPES).map(([k, t]) => [k, t.advisorTopics || []]),
);

function getPostType(key) {
  const t = POST_TYPES[key];
  if (!t) {
    throw new Error(
      `알 수 없는 유형: "${key}". 사용 가능: ${Object.keys(POST_TYPES).join(', ')}`,
    );
  }
  return t;
}

module.exports = {
  POST_TYPES,
  IMAGE_POLICY,
  HOMEFEED_RULES,
  MAX_QUOTES,
  ADVISOR_TOPIC_BY_TYPE,
  getPostType,
};

// 클로드 호출부 — 여기가 "앤트로피 API 키 없이" 도는 핵심.
//
// @anthropic-ai/claude-agent-sdk 의 query()는 클로드 코드와 동일한 인증을 쓴다.
// 즉 사용자가 자기 클로드 구독(Pro/Max)으로 로그인만 되어 있으면 그 구독으로 생성된다.
// ANTHROPIC_API_KEY 필요 없음. (배포앱 로그인 2번 중 "클로드 로그인" 담당)
//
// ⚠️ 배포 시: 개인 구독 인증을 배포앱에서 쓰는 게 약관상 되는지는 배포 전 확인 필요.

const { query } = require('@anthropic-ai/claude-agent-sdk');

/**
 * 시스템/유저 프롬프트를 주고 클로드의 최종 텍스트를 받아온다.
 * 도구·파일접근 전부 끄고 순수 텍스트 생성만 시킨다.
 *
 * @param {object} p
 * @param {string} p.system - 시스템 프롬프트(규칙)
 * @param {string} p.user   - 유저 프롬프트(글감)
 * @param {string} [p.model] - 모델 지정(선택). 비우면 로그인 계정 기본 모델 사용.
 * @returns {Promise<{ text: string, meta: object }>}
 */
async function runClaude({ system, user, model } = {}) {
  // ★출력 잘림 방지 — 긴 글(시형식 20문단+)이 기본 출력토큰 한계에 걸려 "소제목만 있고 본문 없음"으로 잘리는 것 방지.
  //   이건 "천장(상한)"일 뿐이라 글이 필요한 만큼만 쓴다(프로·맥스 동일, 추가 비용 아님). ★ANTHROPIC_API_KEY는 절대 안 씀(구독 인증만) — 삭제까지 한다.
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  if (!childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS) childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '16000';

  const options = {
    systemPrompt: system,
    allowedTools: [], // 도구 없음 — 글만 쓰게
    maxTurns: 8, // 긴 본문(특히 정보형)은 여러 턴에 걸쳐 완성될 수 있어 여유. 도구 없어 폭주 위험 없음.
    permissionMode: 'default',
    settingSources: [], // 프로젝트/유저 설정(CLAUDE.md 등) 안 읽음 → 깨끗한 실행
    env: childEnv,
  };
  // ★글쓰기 기본 모델 = Sonnet (품질 충분 + Opus 대비 토큰 대폭 절감). 비전·키워드추출은 호출측이 haiku를 "명시"로 넘기므로 영향 없음.
  if (!model) model = 'sonnet';
  options.model = model;
  // ★사고 강도(effort) — 기본값 'high'(깊은 추론)는 블로그 글쓰기엔 과해서 "글쓰기 전 생각"에만 토큰·시간을 잔뜩 쓴다(1,574자 글에 출력 14,581토큰 → 6분).
  //   글 품질은 "프롬프트를 따르는 데서" 나오지 사고 깊이에서 나오는 게 아니므로 'medium'(적당한 사고)로 낮춰 속도↑·품질 유지.
  //   ★조절: 더 빠르게=‘low’ / 품질 최대=‘high’. (여기 한 줄만 바꾸면 됨)
  const WRITE_EFFORT = 'medium';
  options.effort = WRITE_EFFORT;

  const q = query({ prompt: user, options });

  let text = '';
  let meta = {};
  for await (const msg of q) {
    if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        text = msg.result;
        meta = {
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          usage: msg.usage,
          model, // ★실제 사용 모델(토큰 로그에서 Opus/Sonnet 확인용)
          promptChars: { system: (system || '').length, user: (user || '').length }, // ★측정용: 규칙서 vs 자료 글자수
        };
      } else {
        // authentication_failed, rate_limit, billing_error, error_max_turns 등
        const st = String(msg.subtype || '');
        // ★"사용량(토큰) 한도" 계열 = error_max_turns(한도 근처면 턴을 다 써 실패) · rate_limit · usage/limit · billing → 명확히 안내.
        if (/max_turns|rate|limit|usage|overload|billing|quota/i.test(st)) {
          const e = new Error('클로드 사용량(토큰) 한도에 도달한 것 같아요. 한도가 리셋된 뒤(보통 5시간 주기) 다시 시도해 주세요. (' + st + ')');
          e.tokenLimit = true; // 호출측이 "한도 실패"로 구분(기록·안내용)
          throw e;
        }
        throw new Error(`클로드 생성 실패(${st}). 클로드 로그인/구독 상태를 확인하세요.`);
      }
    }
  }

  if (!text) throw new Error('클로드가 결과를 반환하지 않았습니다.');
  return { text, meta };
}

module.exports = { runClaude };

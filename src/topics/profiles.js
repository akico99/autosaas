'use strict';

const fsDefault = require('node:fs');
const pathDefault = require('node:path');

const DEFAULT_PROFILES = [
  { key: 'saju-a', topicId: 'saju', name: '명리 공부 기록', blogId: '', persona: '사주를 공부하며 서비스를 만든 운영자', focus: '기초 명리·사주풀이', toneHint: '개념을 쉽게 풀어 설명하는 차분한 말투', frameColor: '#e9dfcf', createdAt: '2026-10-05T00:00:00.000Z' },
  { key: 'saju-b', topicId: 'saju', name: '관계 고민 상담', blogId: '', persona: '연애·궁합·재회 질문을 정리하는 운영자', focus: '궁합·연애·재회', toneHint: '다정한 설명체', frameColor: '#f2dfe7', createdAt: '2026-10-05T00:00:00.000Z' },
  { key: 'saju-c', topicId: 'saju', name: '일과 돈 흐름', blogId: '', persona: '직업·재물·시기 질문을 정리하는 운영자', focus: '직업·재물·택일', toneHint: '똑부러진 정리체', frameColor: '#dce9e4', createdAt: '2026-10-05T00:00:00.000Z' },
];

function readTopicProfiles(file, { fs = fsDefault } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.profiles)) return { profiles: parsed.profiles };
  } catch (_) {}
  return { profiles: DEFAULT_PROFILES.map((profile) => ({ ...profile })) };
}

function writeTopicProfiles(file, value, { fs = fsDefault, path = pathDefault } = {}) {
  const profiles = Array.isArray(value) ? value : value && value.profiles;
  if (!Array.isArray(profiles)) throw new Error('프로필 목록이 올바르지 않습니다.');
  const normalized = profiles.map((profile) => ({ ...profile }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ profiles: normalized }, null, 2), 'utf8');
  fs.renameSync(temp, file);
  return { profiles: normalized };
}

module.exports = { DEFAULT_PROFILES, readTopicProfiles, writeTopicProfiles };

'use strict';

const { saju } = require('./saju');

const mujusky = {
  id: 'mujusky',
  label: '무주스키샵',
  enabled: false,
  siteUrl: 'https://www.mujusky.co.kr',
  domains: ['mujusky.co.kr'],
};

const TOPICS = { saju, mujusky };

module.exports = { TOPICS, saju, mujusky };

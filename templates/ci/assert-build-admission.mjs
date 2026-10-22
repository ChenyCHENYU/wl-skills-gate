#!/usr/bin/env node
// A required check after the authenticated CLI verification, not an approval API.
import { readFileSync } from 'node:fs';

try {
  const [file, project, sha, ...extra] = process.argv.slice(2);
  if (!file || !project || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha || '') || extra.length) throw new Error('缺少本轮准入回执、项目或实际SHA');
  const result = JSON.parse(readFileSync(file, 'utf8'));
  if (result.status !== 'verified' || result.project !== project || result.sha !== sha || result.preBuildFindingsResolved !== true || result.liveVerified !== true) throw new Error('正式Review、严格问题清零或当前CI复验未全部通过，禁止构建');
  console.log(`[build-admission] ${project} / ${sha}：严格准入已通过`);
} catch (error) {
  console.error(`[build-admission] ${error.message}`);
  process.exitCode = 2;
}

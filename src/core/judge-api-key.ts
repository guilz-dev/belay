export function resolveJudgeApiKey(env: NodeJS.ProcessEnv = process.env): {
  key: string | null
  source: 'BELAY_JUDGE_API_KEY' | 'OPENAI_API_KEY' | null
} {
  const belay = env.BELAY_JUDGE_API_KEY?.trim()
  if (belay) {
    return { key: belay, source: 'BELAY_JUDGE_API_KEY' }
  }
  const openai = env.OPENAI_API_KEY?.trim()
  if (openai) {
    return { key: openai, source: 'OPENAI_API_KEY' }
  }
  return { key: null, source: null }
}

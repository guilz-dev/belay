const DEPRECATED_JUDGE_MODEL_AUTO = 'auto'

export function isDeprecatedJudgeModelAuto(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === DEPRECATED_JUDGE_MODEL_AUTO
}

export function rejectDeprecatedJudgeModelAuto(model: string | undefined): void {
  if (isDeprecatedJudgeModelAuto(model)) {
    throw new Error(
      'judge model "auto" is no longer accepted. Use a concrete model id from belay judge list or the provider catalog default.',
    )
  }
}

let warnedDeprecatedAuto = false

export function warnDeprecatedJudgeModelAuto(): void {
  if (warnedDeprecatedAuto) {
    return
  }
  warnedDeprecatedAuto = true
  process.stderr.write(
    'Warning: judge.model "auto" is deprecated; normalized to the provider catalog default on load. Set a concrete model id with belay config set judge.model <id>.\n',
  )
}

/** @internal test helper */
export function resetDeprecatedJudgeModelAutoWarningForTests(): void {
  warnedDeprecatedAuto = false
}

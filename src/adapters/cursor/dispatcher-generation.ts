export const CURSOR_DISPATCHER_GENERATION = 'cursor-owner-router-v1'

export const CURSOR_DISPATCHER_GENERATION_HEADER = `export const BELAY_CURSOR_DISPATCHER_GENERATION = ${JSON.stringify(CURSOR_DISPATCHER_GENERATION)};\n`

export function hasCurrentCursorDispatcherGeneration(source: string): boolean {
  return source.startsWith(CURSOR_DISPATCHER_GENERATION_HEADER)
}

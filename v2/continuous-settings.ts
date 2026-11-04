export interface RetitleContinuousSettings {
  readonly enabled: boolean
  readonly mode: "semantic" | "cadence"
  readonly turnInterval: number
  readonly shadowMode: boolean
  readonly respectManualRename: boolean
}

export function readContinuous(value?: unknown): RetitleContinuousSettings {
  const input = value && typeof value === "object" ? value as Partial<RetitleContinuousSettings> : {}
  return {
    enabled: input.enabled === true,
    mode: input.mode === "cadence" ? "cadence" : "semantic",
    turnInterval: typeof input.turnInterval === "number" && Number.isSafeInteger(input.turnInterval) && input.turnInterval > 0
      ? input.turnInterval : 10,
    shadowMode: input.shadowMode !== false,
    respectManualRename: input.respectManualRename !== false,
  }
}

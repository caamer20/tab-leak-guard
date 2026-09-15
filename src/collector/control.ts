import type {
  CollectorControlCommand,
  CollectorPreflight,
  CollectorHealth
} from "../shared/types";

export type GetRecoveryPreflightCommand = Extract<
  CollectorControlCommand,
  { type: "GET_RECOVERY_PREFLIGHT" }
>;
export type StopCollectorCommand = Extract<CollectorControlCommand, { type: "STOP_COLLECTOR" }>;
export type BackoffCollectorCommand = Extract<CollectorControlCommand, { type: "BACKOFF_COLLECTOR" }>;
export type RecoveryPreflight = CollectorPreflight & {
  collectorHealth: Exclude<CollectorHealth, "stopped">;
};

export type RecoveryPreflightResponse =
  | { ok: true; data: RecoveryPreflight }
  | { ok: false; error: string };

export type StopCollectorResponse =
  | { ok: true; data: { documentInstanceId: string; stopped: true; collectorHealth: "stopped" } }
  | { ok: false; error: string };

export type BackoffCollectorResponse =
  | {
      ok: true;
      data: { documentInstanceId: string; backedOff: true; collectorHealth: "degraded" };
    }
  | { ok: false; error: string };

export function parseCollectorControlCommand(value: unknown): CollectorControlCommand | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => key !== "type" && key !== "expectedDocumentInstanceId")) {
    return null;
  }
  const type = Reflect.get(value, "type");
  if (
    type !== "GET_RECOVERY_PREFLIGHT" &&
    type !== "STOP_COLLECTOR" &&
    type !== "BACKOFF_COLLECTOR"
  ) return null;
  const expectedDocumentInstanceId = Reflect.get(value, "expectedDocumentInstanceId");
  if (
    expectedDocumentInstanceId !== undefined &&
    (typeof expectedDocumentInstanceId !== "string" ||
      expectedDocumentInstanceId.length < 8 ||
      expectedDocumentInstanceId.length > 128)
  ) {
    return null;
  }
  return expectedDocumentInstanceId === undefined
    ? { type }
    : { type, expectedDocumentInstanceId };
}

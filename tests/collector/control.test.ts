import { describe, expect, it } from "vitest";
import { parseCollectorControlCommand } from "../../src/collector/control";

describe("collector control protocol", () => {
  it("accepts preflight and stop commands with bounded optional identity", () => {
    expect(parseCollectorControlCommand({ type: "GET_RECOVERY_PREFLIGHT" })).toEqual({
      type: "GET_RECOVERY_PREFLIGHT"
    });
    expect(
      parseCollectorControlCommand({
        type: "STOP_COLLECTOR",
        expectedDocumentInstanceId: "document-123"
      })
    ).toEqual({ type: "STOP_COLLECTOR", expectedDocumentInstanceId: "document-123" });
  });

  it("rejects malformed or unrelated page messages", () => {
    expect(parseCollectorControlCommand(null)).toBeNull();
    expect(parseCollectorControlCommand({ type: "STOP_COLLECTOR", expectedDocumentInstanceId: "x" })).toBeNull();
    expect(parseCollectorControlCommand({ type: "RESET_TAB" })).toBeNull();
  });
});

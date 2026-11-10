import { describe, expect, it } from "vitest";
import { extractCreatedRecordId } from "@/lib/created-record-id";

describe("extractCreatedRecordId", () => {
  it("reads the nested shape Square returns (confirmed live)", () => {
    expect(extractCreatedRecordId([{ data: { order: { id: "SQ_ORDER" } } }], "order")).toBe("SQ_ORDER");
  });

  it("reads an id directly on the provider payload", () => {
    expect(extractCreatedRecordId([{ data: { id: "P1" } }], "order")).toBe("P1");
  });

  it("reads an id on the entry itself", () => {
    expect(extractCreatedRecordId([{ id: "E1" }], "order")).toBe("E1");
    expect(extractCreatedRecordId({ order: { id: "E2" } }, "order")).toBe("E2");
  });

  it("prefers the entity-keyed id over a generic one", () => {
    expect(extractCreatedRecordId([{ data: { id: "WRAPPER", order: { id: "ORDER" } } }], "order")).toBe("ORDER");
  });

  it.each([undefined, null, [], {}, [{}], [{ data: {} }], [{ data: { order: {} } }], [{ id: "" }], [{ id: 42 }], "text"])(
    "returns undefined for an unrecognised shape: %j",
    (value) => expect(extractCreatedRecordId(value, "order")).toBeUndefined()
  );
});

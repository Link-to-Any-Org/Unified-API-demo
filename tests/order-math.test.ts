import { describe, expect, it } from "vitest";
import {
  assertLineItemCount,
  assertValidQuantity,
  computeOrderTotal,
  MAX_LINE_ITEMS,
  MAX_QUANTITY_PER_LINE,
} from "@/lib/order-math";
import { ValidationError } from "@/lib/errors";
import { roundToCurrencyPrecision } from "@/lib/currency";

describe("assertLineItemCount", () => {
  it("rejects an empty list", () => {
    expect(() => assertLineItemCount([])).toThrow(ValidationError);
  });

  it("accepts a list within the cap", () => {
    const items = Array.from({ length: 3 }, () => ({ variationExternalId: "v1", quantity: 1 }));
    expect(() => assertLineItemCount(items)).not.toThrow();
  });

  it("rejects a list over the cap", () => {
    const items = Array.from({ length: MAX_LINE_ITEMS + 1 }, () => ({
      variationExternalId: "v1",
      quantity: 1,
    }));
    expect(() => assertLineItemCount(items)).toThrow(ValidationError);
  });
});

describe("assertValidQuantity", () => {
  it("accepts a positive integer within the cap", () => {
    expect(() => assertValidQuantity(1, "v1")).not.toThrow();
    expect(() => assertValidQuantity(MAX_QUANTITY_PER_LINE, "v1")).not.toThrow();
  });

  it.each([0, -1, 1.5, NaN, MAX_QUANTITY_PER_LINE + 1])(
    "rejects an invalid quantity: %p",
    (quantity) => {
      expect(() => assertValidQuantity(quantity, "v1")).toThrow(ValidationError);
    }
  );
});

describe("computeOrderTotal", () => {
  it("sums unit price times quantity", () => {
    const total = computeOrderTotal(
      [
        { unitPrice: 9.97, quantity: 2 },
        { unitPrice: 1.5, quantity: 1 },
      ],
      "USD"
    );
    expect(total).toBeCloseTo(21.44, 5);
  });

  it("rounds to the currency's precision", () => {
    const total = computeOrderTotal([{ unitPrice: 0.1, quantity: 3 }], "USD");
    expect(total).toBe(0.3);
  });

  it("returns 0 for no line items", () => {
    expect(computeOrderTotal([], "USD")).toBe(0);
  });
});

describe("roundToCurrencyPrecision", () => {
  it("rounds USD to 2 decimal places", () => {
    expect(roundToCurrencyPrecision(9.978, "USD")).toBe(9.98);
    expect(roundToCurrencyPrecision(9.974, "USD")).toBe(9.97);
  });

  it("rounds a zero-decimal currency to the nearest whole unit", () => {
    expect(roundToCurrencyPrecision(100.6, "JPY")).toBe(101);
  });
});

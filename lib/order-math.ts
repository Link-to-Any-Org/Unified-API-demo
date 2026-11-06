import { ValidationError } from "@/lib/errors";
import { roundToCurrencyPrecision } from "@/lib/currency";

export const MAX_LINE_ITEMS = 50;
export const MAX_QUANTITY_PER_LINE = 99;

export interface RequestedLineItem {
  variationExternalId: string;
  quantity: number;
}

export interface PricedLineItem {
  unitPrice: number;
  quantity: number;
}

export function assertLineItemCount(requested: RequestedLineItem[]): void {
  if (requested.length === 0) {
    throw new ValidationError("At least one line item is required");
  }
  if (requested.length > MAX_LINE_ITEMS) {
    throw new ValidationError(`Too many line items (max ${MAX_LINE_ITEMS})`);
  }
}

export function assertValidQuantity(quantity: number, variationExternalId: string): void {
  if (
    !Number.isInteger(quantity) ||
    quantity <= 0 ||
    quantity > MAX_QUANTITY_PER_LINE
  ) {
    throw new ValidationError(
      `quantity must be a positive integer up to ${MAX_QUANTITY_PER_LINE} (variation ${variationExternalId})`
    );
  }
}

export function computeOrderTotal(lineItems: PricedLineItem[], currencyCode: string): number {
  const rawTotal = lineItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  return roundToCurrencyPrecision(rawTotal, currencyCode);
}

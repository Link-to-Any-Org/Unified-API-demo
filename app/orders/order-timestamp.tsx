"use client";

import { useEffect, useState } from "react";

// Rendered client-side only (after mount) so the formatted time reflects the
// viewer's own locale/timezone instead of the server's, without a
// server/client hydration mismatch.
export default function OrderTimestamp({ iso }: { iso?: string }) {
  const [formatted, setFormatted] = useState<string | null>(null);

  useEffect(() => {
    // Browser locale/timezone isn't available at SSR time, so this has to
    // run after mount - not syncing with an external system that changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (iso) setFormatted(new Date(iso).toLocaleString());
  }, [iso]);

  if (!iso) return null;
  return <>{formatted ?? " "}</>;
}

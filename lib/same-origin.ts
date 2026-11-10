// Tells a form POST made by this app's own pages apart from one submitted
// from another site. Browsers send Sec-Fetch-Site on every request and
// Origin on every POST, so no token in the form is needed. The comparison is
// against the request's own host rather than a configured origin, so it
// holds on localhost and through a tunnel alike. A request with neither
// header (a non-browser client) is treated as cross-site: these routes only
// ever serve the app's own forms.
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";

  const origin = request.headers.get("origin");
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

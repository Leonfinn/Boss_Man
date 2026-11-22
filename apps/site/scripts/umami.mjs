/**
 * Umami page statistics. The script address and the site ID are public (they sit in every page), so they come from the
 * environment, not the repo: UMAMI_SCRIPT_URL (the https address of the script, for example
 * https://stats.example.com/script.js) and UMAMI_WEBSITE_ID (the ID Umami shows for the site). Both empty means no
 * tracking; one without the other, a non-https address or an ID that is not a UUID stops the build.
 * Lives in its own module so check.mjs and build.mjs do not import each other.
 */
export function checkUmami(rawUrl, rawId) {
  const scriptUrl = (rawUrl ?? "").trim();
  const websiteId = (rawId ?? "").trim();
  if (!scriptUrl && !websiteId) return null;
  if (!scriptUrl || !websiteId) throw new Error("UMAMI_SCRIPT_URL and UMAMI_WEBSITE_ID must be set together (or both left empty)");
  let u;
  try {
    u = new URL(scriptUrl);
  } catch {
    throw new Error(`UMAMI_SCRIPT_URL "${scriptUrl}" is not a web address`);
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.host.includes(".")) {
    throw new Error(`UMAMI_SCRIPT_URL must be an https address with a domain name and no login, got "${scriptUrl}"`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(websiteId)) throw new Error("UMAMI_WEBSITE_ID must be the site ID Umami shows (a UUID)");
  return { scriptUrl: u.href, origin: u.origin, websiteId };
}

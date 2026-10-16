// The owner's artwork (assets/brand). See assets/brand/README.md for where each one belongs:
// one illustration per screen, only as an empty or status state, alt text says what it means.
import busy from "../../../assets/brand/boss-busy.webp";
import done from "../../../assets/brand/boss-done.webp";
import logo from "../../../assets/brand/boss-logo.webp";
import mark64 from "../../../assets/brand/boss-mark-64.png";
import mark180 from "../../../assets/brand/boss-mark-180.png";
import setup from "../../../assets/brand/boss-setup.webp";
import stuck from "../../../assets/brand/boss-stuck.webp";
import favicon from "../../../assets/brand/favicon.ico";

export const art = { busy, done, logo, setup, stuck, mark64 };

/** Favicon and touch icon, added at start-up so Vite fingerprints them with everything else. */
export function installIcons(doc: Document = document) {
  const add = (rel: string, href: string, sizes?: string) => {
    const link = doc.createElement("link");
    link.rel = rel;
    link.href = href;
    if (sizes) link.setAttribute("sizes", sizes);
    doc.head.appendChild(link);
  };
  add("icon", favicon, "32x32");
  add("apple-touch-icon", mark180);
}

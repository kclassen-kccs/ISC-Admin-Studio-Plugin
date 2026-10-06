import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getBranding } from "../lib/sailpoint";
import { useAuth } from "./useAuth";

/**
 * Paints the app in the tenant's own ISC branding colours.
 *
 * ISC's branding config carries actionButtonColor / activeLinkColor, which
 * are exactly the two roles the app's blue family already plays (primary
 * buttons, and links/active state). Rather than touch the ~660 call sites,
 * index.css repoints the blue utility classes at --brand-action /
 * --brand-link, and this sets those two variables. Everything else —
 * hover/pressed shades, tints, borders, and the dark-mode variants — is
 * derived from them in CSS, so one hex per role is all that's needed.
 *
 * Deliberately NOT branded: violet, emerald, amber, red. Those carry meaning
 * (role mining, success, warning, danger) rather than identity, and
 * recolouring them to a tenant's brand would lose the distinction.
 *
 * With no branding, an unreadable value, or a failed call, the variables are
 * left alone and the stylesheet's own blue defaults stand — so this can only
 * ever add colour, never break the app's.
 */

// A near-white or near-black "brand" colour would make primary buttons and
// links unreadable against the app's own white/dark surfaces. ISC lets a
// tenant pick either, so anything without enough contrast to sit on BOTH is
// rejected in favour of the default rather than rendered invisible.
const luma = (hex) => {
  const h = String(hex || "").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  if ([r, g, b].some(Number.isNaN)) return null;
  return 0.299 * r + 0.587 * g + 0.114 * b;
};

export function usableBrandColor(hex) {
  const l = luma(hex);
  // Tuned to reject white/near-white (invisible on white surfaces) and pure
  // black (indistinguishable from body text), keeping everything a real
  // brand would plausibly use.
  return l != null && l > 24 && l < 218 ? `#${String(hex).replace("#", "")}` : null;
}

export function applyBrandColors(colors) {
  const root = document.documentElement;
  const action = usableBrandColor(colors?.action);
  // A tenant that set only one of the two gets it applied to both, rather
  // than a half-branded palette.
  const link = usableBrandColor(colors?.link) || action;
  const primary = action || link;

  if (primary) root.style.setProperty("--brand-action", primary);
  else root.style.removeProperty("--brand-action");

  if (link || primary) root.style.setProperty("--brand-link", link || primary);
  else root.style.removeProperty("--brand-link");
}

export function useBrandColors() {
  const { session } = useAuth();
  const { data } = useQuery({
    queryKey: ["branding"],
    queryFn: getBranding,
    enabled: !!session?.tenant,
    staleTime: 10 * 60 * 1000,
  });

  useEffect(() => {
    applyBrandColors(data?.colors);
  }, [data?.colors]);

  // Signing out of a branded tenant must not leave its colours behind for
  // the next one.
  useEffect(() => {
    if (session?.tenant) return undefined;
    applyBrandColors(null);
    return undefined;
  }, [session?.tenant]);
}

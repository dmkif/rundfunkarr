/**
 * Accessibility versions carry an extra layer over the broadcast: audio
 * description speaks the picture over the dialogue, sign language burns an
 * interpreter into the frame, and "klare Sprache" is a simplified re-narration.
 * They are alternative renderings of the same episode, not the episode itself,
 * and the broadcaster sometimes offers *only* them once the regular version has
 * expired -- so they must never be handed out as the regular release.
 *
 * Language variants (OmU, Originalversion, Originalfassung) are deliberately
 * not covered: those are legitimate audio tracks of the work itself, and which
 * one a user wants is a matter of taste, not of correctness.
 */
const ACCESSIBILITY_TERMS =
  "Audiodeskription|H(?:ö|oe)rfassung|H(?:ö|oe)rfilm|Geb(?:ä|ae)rdensprache|DGS|klare Sprache|Leichte Sprache";

// Broadcasters write the annotation in parentheses ("Tatort (DGS)"), as a
// trailing dash suffix ("Sauerkrautkoma - Audiodeskription"), or abbreviate
// audio description to "(AD)" ("Krakonos Geheimnis (AD)").
const ACCESSIBILITY_VERSION = new RegExp(
  `\\([^()]*(?:${ACCESSIBILITY_TERMS})[^()]*\\)|\\s[-–—]\\s*(?:${ACCESSIBILITY_TERMS})\\s*$|\\(\\s*AD\\s*\\)`,
  "i"
);

export function isAccessibilityVersion(title: string): boolean {
  return ACCESSIBILITY_VERSION.test(title);
}

export function formatTitle(title: string): string {
  let formatted = title
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue");

  formatted = formatted.replace(/&/g, "and");
  formatted = formatted.replace(/[/:;,""''@#?$%^*+=!|<>,()]/g, "");
  formatted = formatted.replace(/\s+/g, ".").replace(/\.\./g, ".");

  return formatted;
}

/**
 * Comparison key for episode titles. Broadcasters and TVDB punctuate the same
 * title differently (", Teil 1" vs " - Teil 1", "Wer einmal lügt ..." vs
 * "Wer einmal lügt…"), and formatTitle keeps "-" and runs of dots. Without
 * this, "Schlumpf in die Zukunft, Teil 1" only fuzzy-matched TVDB's
 * "Schlumpf in die Zukunft - Teil 1", and part 2 scored within the "exact"
 * threshold too, so the newer part won. formatTitle stays as it is because it
 * also builds release names.
 */
export function titleMatchKey(title: string): string {
  return formatTitle(title)
    .toLowerCase()
    .replace(/[-.\u2026]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

/**
 * Mediathek titles carry broadcast/accessibility annotations in parentheses,
 * e.g. "Lost Country (Originalversion mit Untertitel)" or "Tatort
 * (Audiodeskription)". They are not part of the film's name and keep Radarr
 * from matching the release, so strip them before building a release title.
 */
const BROADCAST_ANNOTATION =
  /\s*\([^()]*(?:Untertitel|Audiodeskription|Originalversion|Originalfassung|Hörfassung|OmU|klare Sprache|Gebärdensprache|DGS)[^()]*\)/gi;

export function stripBroadcastAnnotations(title: string): string {
  return title.replace(BROADCAST_ANNOTATION, "").replace(/\s+/g, " ").trim();
}

// String similarity using Levenshtein distance
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  const maxLength = Math.max(a.length, b.length);
  return 1 - distance / maxLength;
}

export function tryParseDate(dateString: string): Date | null {
  // Supported German date formats:
  // - "d. MMMM yyyy" (e.g., "7. Juni 2024")
  // - "dd.MM.yyyy" (e.g., "31.12.2017")
  // - "yyyy-MM-dd" (e.g., "2017-12-01")
  // - "yyyyMMdd" (e.g., "20171201")

  const germanMonths: Record<string, number> = {
    januar: 0,
    februar: 1,
    märz: 2,
    april: 3,
    mai: 4,
    juni: 5,
    juli: 6,
    august: 7,
    september: 8,
    oktober: 9,
    november: 10,
    dezember: 11,
  };

  // Try "d. MMMM yyyy" format
  const match1 = dateString.match(/^(\d{1,2})\. (\w+) (\d{4})$/);
  if (match1) {
    const day = parseInt(match1[1]);
    const month = germanMonths[match1[2].toLowerCase()];
    const year = parseInt(match1[3]);
    if (month !== undefined) {
      return new Date(year, month, day);
    }
  }

  // Try "dd.MM.yyyy" format
  const match2 = dateString.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (match2) {
    return new Date(parseInt(match2[3]), parseInt(match2[2]) - 1, parseInt(match2[1]));
  }

  // Try "yyyy-MM-dd" format
  const match3 = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match3) {
    return new Date(parseInt(match3[1]), parseInt(match3[2]) - 1, parseInt(match3[3]));
  }

  // Try "yyyyMMdd" format
  const match4 = dateString.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match4) {
    return new Date(parseInt(match4[1]), parseInt(match4[2]) - 1, parseInt(match4[3]));
  }

  return null;
}

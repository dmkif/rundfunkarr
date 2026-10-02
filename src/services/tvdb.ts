import { prisma } from "@/lib/db";
import { tvdbCache } from "@/lib/cache";
import { fetchWithRetry } from "@/lib/fetch-retry";
import { getSettings } from "@/lib/settings";
import { buildTvdbLoginPayload } from "@/lib/tvdb-auth";
import type { TvdbData, TvdbEpisode, TvdbAlias } from "@/types";

const TVDB_API_URL = "https://api4.thetvdb.com/v4";

// Token management
let cachedToken: string | null = null;
let tokenExpiry: Date | null = null;

export function clearTvdbTokenMemoryCache(): void {
  cachedToken = null;
  tokenExpiry = null;
}

export async function clearTvdbTokenCache(): Promise<void> {
  clearTvdbTokenMemoryCache();
  await prisma.config.deleteMany({
    where: { key: { in: ["tvdb_token", "tvdb_token_expiry"] } },
  });
}

async function getToken(): Promise<string | null> {
  // Check if we have a valid cached token
  if (cachedToken && tokenExpiry && new Date() < tokenExpiry) {
    return cachedToken;
  }

  // Check database for stored token
  const storedToken = await prisma.config.findUnique({
    where: { key: "tvdb_token" },
  });

  const storedExpiry = await prisma.config.findUnique({
    where: { key: "tvdb_token_expiry" },
  });

  if (storedToken && storedExpiry) {
    const expiry = new Date(storedExpiry.value);
    if (new Date() < expiry) {
      cachedToken = storedToken.value;
      tokenExpiry = expiry;
      return cachedToken;
    }
  }

  // Need to refresh token
  return refreshToken();
}

async function refreshToken(): Promise<string | null> {
  const settings = await getSettings(["api.tvdb.key", "api.tvdb.pin"]);
  const apiKey = settings["api.tvdb.key"];
  const pin = settings["api.tvdb.pin"];
  const payload = buildTvdbLoginPayload(apiKey, pin);

  if (!payload) {
    console.error("TVDB API key not configured in settings");
    return null;
  }

  try {
    const response = await fetchWithRetry(`${TVDB_API_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (data.status === "success" && data.data?.token) {
      const token = data.data.token;
      const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // Store in database
      await prisma.config.upsert({
        where: { key: "tvdb_token" },
        update: { value: token },
        create: { key: "tvdb_token", value: token },
      });

      await prisma.config.upsert({
        where: { key: "tvdb_token_expiry" },
        update: { value: expiry.toISOString() },
        create: { key: "tvdb_token_expiry", value: expiry.toISOString() },
      });

      cachedToken = token;
      tokenExpiry = expiry;

      return token;
    }

    console.error("Failed to get TVDB token:", data);
    return null;
  } catch (error) {
    console.error("Error refreshing TVDB token:", error);
    return null;
  }
}

export async function getShowInfoByTvdbId(tvdbId: number): Promise<TvdbData | null> {
  // Guard against undefined/null tvdbId
  if (tvdbId === undefined || tvdbId === null) {
    return null;
  }

  // Check memory cache first
  const cacheKey = `tvdb_${tvdbId}`;
  const cached = tvdbCache.get(cacheKey) as TvdbData | undefined;
  if (cached) {
    return cached;
  }

  // Check database cache
  await ensureTvdbCacheVersion();
  const dbSeries = await prisma.tvdbSeries.findUnique({
    where: { id: tvdbId },
    include: { episodes: true },
  });

  if (dbSeries && new Date() < dbSeries.expiresAt) {
    const tvdbData: TvdbData = {
      id: dbSeries.id,
      name: dbSeries.name,
      germanName: dbSeries.germanName,
      aliases: dbSeries.aliases ? JSON.parse(dbSeries.aliases) : [],
      episodes: dbSeries.episodes.map((ep) => ({
        name: ep.name || "",
        aired: ep.aired,
        runtime: ep.runtime,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
      })),
    };

    tvdbCache.set(cacheKey, tvdbData);
    return tvdbData;
  }

  // Fetch from TVDB API
  return fetchAndCacheSeriesData(tvdbId);
}

// Bump when the cached series/episode data changes meaning, so rows written
// by an older version are refetched instead of served until they expire.
// 2: episode names and the German series name are German translations.
const TVDB_CACHE_VERSION = "2";
let tvdbCacheVersionChecked = false;

async function ensureTvdbCacheVersion(): Promise<void> {
  if (tvdbCacheVersionChecked) return;

  const stored = await prisma.config.findUnique({ where: { key: "tvdb_cache_version" } });
  if (stored?.value !== TVDB_CACHE_VERSION) {
    console.log(`[TVDB] Cache version changed, dropping cached series data`);
    await prisma.$transaction([
      prisma.tvdbEpisode.deleteMany({}),
      prisma.tvdbSeries.deleteMany({}),
      prisma.config.upsert({
        where: { key: "tvdb_cache_version" },
        update: { value: TVDB_CACHE_VERSION },
        create: { key: "tvdb_cache_version", value: TVDB_CACHE_VERSION },
      }),
    ]);
  }
  tvdbCacheVersionChecked = true;
}

async function fetchTvdbJson(
  path: string,
  token: string
): Promise<{ data?: unknown; links?: { next?: string | null } } | null> {
  const response = await fetchWithRetry(`${TVDB_API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data?.status === "success" ? data : null;
}

/**
 * German series translation. The extended series record only lists which
 * languages exist (nameTranslations is an array of language codes), so the
 * name has to come from the translations endpoint.
 */
async function fetchGermanSeriesTranslation(
  tvdbId: number,
  token: string
): Promise<{ name: string | null; aliases: string[] }> {
  try {
    const data = await fetchTvdbJson(`/series/${tvdbId}/translations/deu`, token);
    const translation = data?.data as
      | { name?: string | null; aliases?: string[] | null }
      | undefined;
    return { name: translation?.name || null, aliases: translation?.aliases || [] };
  } catch (error) {
    console.warn(`[TVDB] No German series translation for ${tvdbId}:`, error);
    return { name: null, aliases: [] };
  }
}

/**
 * German episode names keyed by "season:episode". The extended series record
 * names episodes in the series' original language, which never matches a
 * German Mediathek title for foreign shows (French, English, Swedish, ...).
 */
async function fetchGermanEpisodeNames(
  tvdbId: number,
  token: string
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for (let page = 0; ; page++) {
      const data = await fetchTvdbJson(
        `/series/${tvdbId}/episodes/default/deu?page=${page}`,
        token
      );
      const episodes = (data?.data as { episodes?: unknown[] } | undefined)?.episodes;
      if (!episodes) break;

      for (const ep of episodes as {
        name?: string | null;
        seasonNumber: number;
        number: number;
      }[]) {
        if (ep.name) names.set(episodeKey(ep.seasonNumber, ep.number), ep.name);
      }
      if (!data?.links?.next) break;
    }
  } catch (error) {
    console.warn(`[TVDB] Could not fetch German episode names for ${tvdbId}:`, error);
  }
  return names;
}

function episodeKey(seasonNumber: number, episodeNumber: number): string {
  return `${seasonNumber}:${episodeNumber}`;
}

/** Prefer the German episode name; keep the original name where none exists. */
export function germanEpisodeName(
  germanNames: Map<string, string>,
  ep: { name?: string | null; seasonNumber: number; number: number }
): string {
  return germanNames.get(episodeKey(ep.seasonNumber, ep.number)) || ep.name || "";
}

async function fetchAndCacheSeriesData(tvdbId: number): Promise<TvdbData | null> {
  const token = await getToken();
  if (!token) {
    return null;
  }

  try {
    const response = await fetchWithRetry(
      `${TVDB_API_URL}/series/${tvdbId}/extended?meta=episodes&short=true`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );

    const data = await response.json();

    if (!data || data.status !== "success") {
      console.error("Failed to fetch data from TVDB:", data);
      return null;
    }

    const series = data.data;

    const [germanTranslation, germanEpisodeNames] = await Promise.all([
      fetchGermanSeriesTranslation(tvdbId, token),
      fetchGermanEpisodeNames(tvdbId, token),
    ]);

    const germanName = germanTranslation.name || series.name;

    // Extract German aliases
    const rawAliases = series.aliases || [];
    const germanAliases: TvdbAlias[] = rawAliases
      .filter((alias: { language?: string; name?: string }) => alias.language === "deu")
      .map((alias: { language: string; name: string }) => ({
        language: alias.language,
        name: alias.name,
      }));
    for (const name of germanTranslation.aliases) {
      if (!germanAliases.some((alias) => alias.name === name)) {
        germanAliases.push({ language: "deu", name });
      }
    }

    // Calculate cache expiry based on activity
    const now = new Date();
    const lastUpdated = series.lastUpdated ? new Date(series.lastUpdated) : new Date("1970-01-01");
    const nextAired = series.nextAired ? new Date(series.nextAired) : new Date("1970-01-01");
    const lastAired = series.lastAired ? new Date(series.lastAired) : new Date("1970-01-01");

    let cacheExpiry = new Date();
    const daysDiff = (d1: Date, d2: Date) =>
      Math.abs(d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24);

    if (
      daysDiff(lastUpdated, now) < 7 ||
      (nextAired.getTime() > 0 && daysDiff(nextAired, now) < 6) ||
      (lastAired.getTime() > 0 && daysDiff(lastAired, now) < 3)
    ) {
      cacheExpiry.setDate(cacheExpiry.getDate() + 2);
    } else {
      cacheExpiry.setDate(cacheExpiry.getDate() + 6);
    }

    // Map episodes
    const episodes: TvdbEpisode[] = (series.episodes || []).map(
      (ep: {
        name?: string;
        aired?: string;
        runtime?: number;
        seasonNumber: number;
        number: number;
      }) => ({
        name: germanEpisodeName(germanEpisodeNames, ep),
        aired: ep.aired ? new Date(ep.aired) : null,
        runtime: ep.runtime || null,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.number,
      })
    );

    // Store in database
    await prisma.$transaction(async (tx) => {
      // Delete existing data
      await tx.tvdbEpisode.deleteMany({ where: { seriesId: tvdbId } });
      await tx.tvdbSeries.deleteMany({ where: { id: tvdbId } });

      // Insert series
      await tx.tvdbSeries.create({
        data: {
          id: tvdbId,
          name: series.name,
          germanName: germanName,
          slug: series.slug || null,
          firstAired: series.firstAired ? new Date(series.firstAired) : null,
          aliases: JSON.stringify(germanAliases),
          expiresAt: cacheExpiry,
        },
      });

      // Insert episodes in batch
      const episodesData = (series.episodes || []).map(
        (ep: {
          id: number;
          name?: string;
          aired?: string;
          runtime?: number;
          seasonNumber: number;
          number: number;
        }) => ({
          id: ep.id,
          seriesId: tvdbId,
          name: germanEpisodeName(germanEpisodeNames, ep),
          aired: ep.aired ? new Date(ep.aired) : null,
          runtime: ep.runtime || null,
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.number,
        })
      );

      if (episodesData.length > 0) {
        await tx.tvdbEpisode.createMany({ data: episodesData });
      }
    });

    const tvdbData: TvdbData = {
      id: tvdbId,
      name: series.name,
      germanName: germanName,
      aliases: germanAliases,
      episodes: episodes,
    };

    // Store in memory cache
    const cacheKey = `tvdb_${tvdbId}`;
    tvdbCache.set(cacheKey, tvdbData);

    return tvdbData;
  } catch (error) {
    console.error("Error fetching TVDB data:", error);
    return null;
  }
}

import { describe, it, expect, vi, beforeEach } from "vitest";

// Keep the unit hermetic: no DB, no network.
const configRows = new Map<string, string>();
const tx = {
  tvdbEpisode: { deleteMany: vi.fn(), createMany: vi.fn() },
  tvdbSeries: { deleteMany: vi.fn(), create: vi.fn() },
};
vi.mock("@/lib/db", () => ({
  prisma: {
    config: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        configRows.has(where.key) ? { key: where.key, value: configRows.get(where.key) } : null
      ),
      upsert: vi.fn(
        async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
          configRows.set(where.key, update.value);
        }
      ),
      deleteMany: vi.fn(),
    },
    tvdbSeries: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn() },
    tvdbEpisode: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === "function"
        ? (arg as (t: typeof tx) => Promise<unknown>)(tx)
        : Promise.all(arg as unknown[])
    ),
  },
}));
vi.mock("@/lib/cache", () => ({
  tvdbCache: { get: vi.fn().mockReturnValue(undefined), set: vi.fn() },
}));
vi.mock("@/lib/settings", () => ({ getSettings: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/fetch-retry", () => ({ fetchWithRetry: vi.fn() }));

import { getShowInfoByTvdbId, germanEpisodeName } from "./tvdb";
import { fetchWithRetry } from "@/lib/fetch-retry";
import { prisma } from "@/lib/db";

const mockedFetch = vi.mocked(fetchWithRetry);

function json(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

// Die Schlümpfe (2021): a French original, so TVDB's extended record names
// everything in French while KiKA titles are German.
function mockTvdb(): void {
  mockedFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith("/series/392426/extended?meta=episodes&short=true")) {
      return json({
        status: "success",
        data: {
          name: "Les Schtroumpfs (2021)",
          nameTranslations: ["fra", "eng", "deu"],
          aliases: [],
          episodes: [
            {
              id: 1,
              name: "La Machine à schtroumpfer dans le temps (Partie 1)",
              seasonNumber: 2,
              number: 32,
            },
            {
              id: 2,
              name: "La Machine à schtroumpfer dans le temps (Partie 2)",
              seasonNumber: 2,
              number: 33,
            },
            { id: 3, name: "Sans traduction", seasonNumber: 2, number: 34 },
          ],
        },
      });
    }
    if (u.endsWith("/series/392426/translations/deu")) {
      return json({
        status: "success",
        data: { name: "Die Schlümpfe (2021)", aliases: ["Schlümpfe"] },
      });
    }
    if (u.endsWith("/series/392426/episodes/default/deu?page=0")) {
      return json({
        status: "success",
        data: {
          episodes: [
            { name: "Schlumpf in die Zukunft - Teil 1", seasonNumber: 2, number: 32 },
            { name: "Schlumpf in die Zukunft - Teil 2", seasonNumber: 2, number: 33 },
            { name: null, seasonNumber: 2, number: 34 },
          ],
        },
        links: { next: null },
      });
    }
    throw new Error(`unexpected URL ${u}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  configRows.clear();
  configRows.set("tvdb_token", "token");
  configRows.set("tvdb_token_expiry", new Date(Date.now() + 3_600_000).toISOString());
});

describe("germanEpisodeName", () => {
  const names = new Map([["2:32", "Schlumpf in die Zukunft - Teil 1"]]);

  it("prefers the German name", () => {
    expect(germanEpisodeName(names, { name: "Partie 1", seasonNumber: 2, number: 32 })).toBe(
      "Schlumpf in die Zukunft - Teil 1"
    );
  });

  it("falls back to the original name without a German translation", () => {
    expect(germanEpisodeName(names, { name: "Sans traduction", seasonNumber: 2, number: 34 })).toBe(
      "Sans traduction"
    );
  });
});

describe("getShowInfoByTvdbId – foreign-language series", () => {
  it("returns and caches German episode names and the German series name", async () => {
    mockTvdb();

    const show = await getShowInfoByTvdbId(392426);

    expect(show?.name).toBe("Les Schtroumpfs (2021)");
    expect(show?.germanName).toBe("Die Schlümpfe (2021)");
    expect(show?.aliases).toContainEqual({ language: "deu", name: "Schlümpfe" });
    expect(show?.episodes.map((e) => e.name)).toEqual([
      "Schlumpf in die Zukunft - Teil 1",
      "Schlumpf in die Zukunft - Teil 2",
      "Sans traduction",
    ]);

    const stored = tx.tvdbEpisode.createMany.mock.calls[0][0].data as { name: string }[];
    expect(stored.map((e) => e.name)).toEqual(show?.episodes.map((e) => e.name));
    expect(tx.tvdbSeries.create.mock.calls[0][0].data.germanName).toBe("Die Schlümpfe (2021)");
  });

  it("keeps working with original names when the German lookups fail", async () => {
    mockTvdb();
    const base = mockedFetch.getMockImplementation()!;
    mockedFetch.mockImplementation(async (url, init) =>
      String(url).includes("/deu") ? json({ status: "failure" }, false) : base(url, init)
    );

    const show = await getShowInfoByTvdbId(392426);

    expect(show?.germanName).toBe("Les Schtroumpfs (2021)");
    expect(show?.episodes[0].name).toBe("La Machine à schtroumpfer dans le temps (Partie 1)");
  });

  it("drops series data cached before German names, once", async () => {
    // The version check runs once per process, so start from a fresh module.
    vi.resetModules();
    const { getShowInfoByTvdbId: freshGetShowInfo } = await import("./tvdb");
    mockTvdb();
    await freshGetShowInfo(392426);

    expect(prisma.tvdbSeries.deleteMany).toHaveBeenCalledWith({});
    expect(prisma.tvdbEpisode.deleteMany).toHaveBeenCalledWith({});
    expect(configRows.get("tvdb_cache_version")).toBe("2");

    vi.mocked(prisma.tvdbSeries.deleteMany).mockClear();
    await freshGetShowInfo(392426);
    expect(prisma.tvdbSeries.deleteMany).not.toHaveBeenCalled();
  });
});

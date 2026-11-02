import { describe, expect, it, vi } from "vitest";
import type { ApiResultItem, TmdbMovieData } from "@/types";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("./tmdb", () => ({ searchMovieCandidates: vi.fn().mockResolvedValue([]) }));

import { matchMovieItems } from "./movie-matcher";
import { searchMovieCandidates } from "./tmdb";

const mockedCandidates = vi.mocked(searchMovieCandidates);

const movie: TmdbMovieData = {
  tmdbId: 28,
  imdbId: "tt0000028",
  title: "Documentary",
  germanTitle: "Documentary",
  runtime: 45,
  releaseDate: "2026-07-12",
};

function makeItem(duration: number, id: string): ApiResultItem {
  return {
    channel: "ARD",
    topic: "Documentary",
    title: "Documentary",
    description: "",
    filmlisteTimestamp: 1_700_000_000,
    duration,
    size: 1_000_000,
    url_website: `https://example.com/${id}`,
    url_video: `https://example.com/${id}.mp4`,
    url_video_low: "",
    url_video_hd: "",
  };
}

function makeBroadcast(topic: string, title: string, minutes: number): ApiResultItem {
  return {
    ...makeItem(minutes * 60, `${topic}-${title}-${minutes}`),
    topic,
    title,
  };
}

function makeMovie(germanTitle: string, runtime: number | null, title = germanTitle) {
  return { ...movie, title, germanTitle, runtime };
}

async function matchedTitles(items: ApiResultItem[], movieData: TmdbMovieData) {
  const matches = await matchMovieItems(items, movieData, 0);
  return matches.map((match) => `${match.item.title} (${match.item.duration / 60} min)`);
}

describe("matchMovieItems – minimum duration", () => {
  it("compares durations in seconds at the configured boundary", async () => {
    const matches = await matchMovieItems(
      [makeItem(2699, "short"), makeItem(2700, "boundary")],
      movie,
      2700
    );

    expect(matches.map((match) => match.item.url_video)).toEqual([
      "https://example.com/boundary.mp4",
    ]);
  });

  it("does not filter by duration when the setting is zero", async () => {
    const matches = await matchMovieItems(
      [makeItem(120, "short")],
      makeMovie("Documentary", null),
      0
    );

    expect(matches).toHaveLength(1);
  });
});

describe("matchMovieItems – TMDB runtime", () => {
  const theGeneral = makeMovie("Der General", 79, "The General");

  it("rejects broadcasts whose duration clearly differs from the runtime", async () => {
    const titles = await matchedTitles(
      [
        makeBroadcast("Filme", "Der General", 45),
        makeBroadcast("Filme", "Der General", 58),
        makeBroadcast("Filme", "Der General", 59),
        makeBroadcast("Filme", "Der General", 99),
        makeBroadcast("Filme", "Der General", 100),
      ],
      theGeneral
    );

    // 25 % of 79 minutes is less than twice the default tolerance of 10 minutes
    expect(titles).toEqual(["Der General (59 min)", "Der General (99 min)"]);
  });

  it("allows TV versions that differ by up to a quarter of a long runtime", async () => {
    const titles = await matchedTitles(
      [
        makeBroadcast("Filme", "Metropolis", 111),
        makeBroadcast("Filme", "Metropolis", 110),
        makeBroadcast("Megacitys", "Metropolis", 43),
      ],
      makeMovie("Metropolis", 148)
    );

    expect(titles).toEqual(["Metropolis (111 min)"]);
  });

  it("keeps exact title matches when TMDB has no runtime", async () => {
    const titles = await matchedTitles(
      [makeBroadcast("Dokumentationen", "Das geheime Wesen der Katzen", 43)],
      makeMovie("Das geheime Wesen der Katzen", null)
    );

    expect(titles).toEqual(["Das geheime Wesen der Katzen (43 min)"]);
  });
});

describe("matchMovieItems – unknown broadcast duration", () => {
  it("skips the runtime check for exact titles but not for title parts", async () => {
    // The local Filmliste stores 0 when the duration is missing
    const titles = await matchedTitles(
      [
        makeBroadcast("Filme", "Der General", 0),
        makeBroadcast("Filme", "Der General (Audiodeskription)", 0),
        makeBroadcast("Kunst & Kultur", "Der General - Valencia", 0),
      ],
      makeMovie("Der General", 79, "The General")
    );

    expect(titles).toEqual(["Der General (0 min)", "Der General (Audiodeskription) (0 min)"]);
  });
});

describe("matchMovieItems – title", () => {
  const theGeneral = makeMovie("Der General", 79, "The General");

  it("does not accept the movie title as a substring of another title", async () => {
    const titles = await matchedTitles(
      [
        makeBroadcast("Filme in der ARD", "Die Diebin & der General", 88),
        makeBroadcast("phoenix parlament", "Olaf Scholz in der Generaldebatte", 80),
        makeBroadcast("Alle meine Töchter", "Der Generalflop (S03/E06)", 80),
        makeBroadcast("Story", "Soldat Nr. 1 – Der General und die Zeitenwende", 80),
      ],
      theGeneral
    );

    expect(titles).toEqual([]);
  });

  it("treats version notes like an exact title, even without a TMDB runtime", async () => {
    const items = [
      makeBroadcast("Filme im Ersten", "Der General - Audiodeskription", 70),
      makeBroadcast("Kino - Filme", "Der General (Originalversion mit Untertitel)", 70),
      makeBroadcast("Spielfilm", "Der General - Spielfilm, USA 1926", 70),
      makeBroadcast("Filme", "Der General (Originalton)", 70),
      makeBroadcast("Filme", "Der General (AD)", 70),
    ];

    const matches = await matchMovieItems(items, theGeneral, 0);
    expect(matches.map((match) => match.titleMatch)).toEqual(Array(5).fill("exact"));
    expect(await matchedTitles(items, makeMovie("Der General", null))).toHaveLength(5);
  });

  it("requires a runtime within the tolerance for other title parts", async () => {
    const items = [
      makeBroadcast("Kunst & Kultur", "Metropolis - Valencia", 44),
      makeBroadcast("Spielfilm", "Metropolis - Die Stadt der Zukunft", 145),
      makeBroadcast("Spielfilm", "Metropolis - Die Stadt der Zukunft", 125),
    ];

    expect(await matchedTitles(items, makeMovie("Metropolis", 148))).toEqual([
      "Metropolis - Die Stadt der Zukunft (145 min)",
    ]);
    expect(await matchedTitles(items, makeMovie("Metropolis", null))).toEqual([]);
  });

  it("splits title parts at a period", async () => {
    const items = [makeBroadcast("Filme im Ersten", "Dampfnudelblues. Ein Eberhoferkrimi", 86)];

    expect(await matchedTitles(items, makeMovie("Dampfnudelblues", 87))).toEqual([
      "Dampfnudelblues. Ein Eberhoferkrimi (86 min)",
    ]);
    expect(await matchedTitles(items, makeMovie("Dampfnudelblues", null))).toEqual([]);
    // Abbreviations are split as well, but still match as a whole
    expect(
      await matchedTitles(
        [makeBroadcast("Filme", "Das Testament des Dr. Mabuse (Audiodeskription)", 120)],
        makeMovie("Das Testament des Dr. Mabuse", null)
      )
    ).toEqual(["Das Testament des Dr. Mabuse (Audiodeskription) (120 min)"]);
  });

  it("treats editions like the film within the runtime limit", async () => {
    const titles = await matchedTitles(
      [
        makeBroadcast("Spielfilm", "Apocalypse Now - Final Cut - Spielfilm, USA 1979/2019", 169),
        makeBroadcast("Spielfilm", "Apocalypse Now - Director's Cut", 150),
        makeBroadcast("Spielfilm", "Apocalypse Now - Redux", 202),
      ],
      makeMovie("Apocalypse Now", 147)
    );

    // 202 minutes exceed 25 % of the TMDB runtime
    expect(titles).toEqual([
      "Apocalypse Now - Director's Cut (150 min)",
      "Apocalypse Now - Final Cut - Spielfilm, USA 1979/2019 (169 min)",
    ]);
  });

  it("treats a title part as weak even when the whole title is similar", async () => {
    // "Metropolis - XL" is about 77 % similar to "Metropolis"
    const items = [makeBroadcast("Spielfilm", "Metropolis - XL", 125)];

    expect(await matchedTitles(items, makeMovie("Metropolis", 148))).toEqual([]);
    expect(await matchedTitles(items, makeMovie("Metropolis", null))).toEqual([]);
  });

  it("does not accept a topic named like the movie with another title", async () => {
    const weniger = makeMovie("Weniger ist mehr", null);

    expect(
      await matchedTitles(
        [
          makeBroadcast("Weniger ist mehr", "Guggen spielen um die Ehre", 22),
          makeBroadcast("Weniger ist mehr", "Kurios", 22),
        ],
        weniger
      )
    ).toEqual([]);
    expect(
      await matchedTitles([makeBroadcast("Weniger ist mehr", "Audiodeskription", 86)], weniger)
    ).toEqual(["Audiodeskription (86 min)"]);
  });

  it("accepts production notes only when they describe a film", async () => {
    const titles = await matchedTitles(
      [
        makeBroadcast("Kunst & Kultur", "Metropolis - Valencia, Spanien 2024", 44),
        makeBroadcast("Spielfilm", "Metropolis - Spielfilm, Deutschland 1927", 145),
        makeBroadcast("Fernsehfilm", "Metropolis - Ein Stummfilmkrimi, Deutschland 1927", 145),
        makeBroadcast("Fernsehfilm", "Metropolis - Historisches Drama, Deutschland 1927", 145),
        makeBroadcast("Fernsehfilm", "Metropolis - Romantische Komödie, Deutschland 1927", 145),
      ],
      makeMovie("Metropolis", null)
    );

    expect(titles).toEqual([
      "Metropolis - Spielfilm, Deutschland 1927 (145 min)",
      "Metropolis - Ein Stummfilmkrimi, Deutschland 1927 (145 min)",
      "Metropolis - Historisches Drama, Deutschland 1927 (145 min)",
      "Metropolis - Romantische Komödie, Deutschland 1927 (145 min)",
    ]);
  });

  it("matches titles that contain separators or span topic and title", async () => {
    const mission = await matchedTitles(
      [makeBroadcast("Spielfilm", "Mission: Impossible (Audiodeskription)", 110)],
      makeMovie("Mission: Impossible", 110)
    );
    const klaraSonntag = await matchedTitles(
      [makeBroadcast("Klara Sonntag", "Liebe macht blind - Fernsehfilm, Deutschland 2022", 88)],
      makeMovie("Klara Sonntag - Liebe macht blind", 89)
    );

    expect(mission).toEqual(["Mission: Impossible (Audiodeskription) (110 min)"]);
    expect(klaraSonntag).toEqual(["Liebe macht blind - Fernsehfilm, Deutschland 2022 (88 min)"]);
  });

  it("prefers an exact original title over a German title part", async () => {
    // "Paris" is only a part of the title, "Paris - Je t'aime" is the whole title
    const matches = await matchMovieItems(
      [makeBroadcast("Kino", "Paris - Je t'aime", 120)],
      makeMovie("Paris", null, "Paris, je t'aime"),
      0
    );

    expect(matches.map((match) => match.titleMatch)).toEqual(["exact"]);
  });
});

describe("matchMovieItems – entries that are a different film", () => {
  const saltkrokan: TmdbMovieData = {
    ...movie,
    tmdbId: 355659,
    title: "Vi på Saltkråkan",
    germanTitle: "Ferien auf Saltkrokan",
    runtime: 90,
  };
  const sequel = makeBroadcast("Filme", "Ferien auf Saltkrokan: Das Trollkind", 88);

  it("rejects a sequel that TMDB knows under the Mediathek title", async () => {
    mockedCandidates.mockResolvedValueOnce([
      {
        id: 433396,
        title: "Ferien auf Saltkrokan - Das Trollkind",
        originalTitle: "Tjorven och Skrållan",
      },
      { id: 355659, title: "Ferien auf Saltkrokan", originalTitle: "Vi på Saltkråkan" },
    ]);

    const matches = await matchMovieItems([sequel], saltkrokan, 300);

    expect(matches).toHaveLength(0);
  });

  it("rejects a film with a similar name that TMDB knows", async () => {
    const benigni: TmdbMovieData = {
      ...movie,
      tmdbId: 637,
      title: "La vita è bella",
      germanTitle: "Das Leben ist schön",
      runtime: 116,
    };
    mockedCandidates.mockResolvedValueOnce([
      { id: 1585, title: "Ist das Leben nicht schön?", originalTitle: "It's a Wonderful Life" },
    ]);
    const capra = makeBroadcast("Film", "Ist das Leben nicht schön?", 125);

    const matches = await matchMovieItems([capra], benigni, 300);

    expect(matches).toHaveLength(0);
  });

  it("keeps the entry when TMDB finds our film first", async () => {
    // "Dampfnudelblues. Ein Eberhoferkrimi" is only a partial title match,
    // but TMDB's search for it finds the film itself.
    const dampfnudel: TmdbMovieData = {
      ...movie,
      tmdbId: 209232,
      title: "Dampfnudelblues",
      germanTitle: "Dampfnudelblues",
      runtime: 87,
    };
    mockedCandidates.mockResolvedValueOnce([
      { id: 209232, title: "Dampfnudelblues", originalTitle: "Dampfnudelblues" },
    ]);
    const item = makeBroadcast("Filme in der ARD", "Dampfnudelblues. Ein Eberhoferkrimi", 87);

    const matches = await matchMovieItems([item], dampfnudel, 300);

    expect(matches).toHaveLength(1);
  });

  it("keeps the entry when TMDB cannot answer", async () => {
    mockedCandidates.mockResolvedValueOnce(null);

    const matches = await matchMovieItems([sequel], saltkrokan, 300);

    expect(matches).toHaveLength(1);
  });

  it("does not ask TMDB for an exact title match", async () => {
    mockedCandidates.mockClear();
    const exact = makeBroadcast("Filme", "Ferien auf Saltkrokan", 90);
    const audioDescribed = makeBroadcast("Filme", "Ferien auf Saltkrokan (Audiodeskription)", 90);

    await matchMovieItems([exact, audioDescribed], saltkrokan, 300);

    expect(mockedCandidates).not.toHaveBeenCalled();
  });

  it("checks an exact match that only came from the topic", async () => {
    const wickie2009: TmdbMovieData = {
      ...movie,
      tmdbId: 22355,
      title: "Wickie und die starken Männer",
      germanTitle: "Wickie und die starken Männer",
      runtime: 85,
    };
    mockedCandidates.mockResolvedValueOnce([
      {
        id: 648572,
        title: "Wickie und die starken Männer – Das magische Schwert",
        originalTitle: "Vic the Viking and the Magic Sword",
      },
    ]);
    const sword = makeBroadcast(
      "Wickie und die starken Männer",
      "Wickie und die starken Männer - Das magische Schwert",
      79
    );

    const matches = await matchMovieItems([sword], wickie2009, 300);

    expect(matches).toHaveLength(0);
  });

  it("finds a film title in typographic quotes", async () => {
    const shaun: TmdbMovieData = {
      ...movie,
      tmdbId: 263109,
      title: "Shaun the Sheep Movie",
      germanTitle: "Shaun das Schaf - Der Film",
      runtime: 85,
    };
    const item = makeBroadcast(
      "Film",
      "«Shaun das Schaf – Der Film» – Lustiges Abenteuer für die ganze Familie",
      82
    );

    const matches = await matchMovieItems([item], shaun, 300);

    expect(matches).toHaveLength(1);
  });
});

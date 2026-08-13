import { describe, expect, it, vi } from "vitest";
import type { ApiResultItem, TmdbMovieData } from "@/types";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

import { matchMovieItems } from "./movie-matcher";

const movie: TmdbMovieData = {
  tmdbId: 28,
  imdbId: "tt0000028",
  title: "Documentary",
  germanTitle: "Documentary",
  runtime: 45,
  releaseDate: "2026-07-12",
};

function makeItem(
  duration: number,
  id: string,
  overrides: Partial<ApiResultItem> = {}
): ApiResultItem {
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
    ...overrides,
  };
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

  it("does not filter by the setting when it is zero", async () => {
    // 40 min against a 45 min film: below any minimum-duration setting one
    // might configure, but still plausible for the film itself.
    const matches = await matchMovieItems([makeItem(2400, "short")], movie, 0);

    expect(matches).toHaveLength(1);
  });
});

describe("matchMovieItems – runtime plausibility", () => {
  it("rejects a featurette that carries the film's name", async () => {
    // "Nevrland: Auf der Suche" -- a 6 min festival clip whose topic is exactly
    // the film's title, which used to win on title score alone.
    const nevrland: TmdbMovieData = { ...movie, title: "Nevrland", germanTitle: "Nevrland" };
    const clip = makeItem(356, "clip", { topic: "Nevrland", title: "Auf der Suche" });
    const film = makeItem(5098, "film", { topic: "Spielfilm", title: "Nevrland" });

    const matches = await matchMovieItems([clip, film], { ...nevrland, runtime: 89 }, 300);

    expect(matches.map((match) => match.item.url_video)).toEqual(["https://example.com/film.mp4"]);
  });

  it("rejects an overlong entry", async () => {
    const matches = await matchMovieItems([makeItem(45 * 60 * 2, "double")], movie, 0);

    expect(matches).toHaveLength(0);
  });

  it("only rejects clips when TMDB reports no runtime", async () => {
    // "Der süße Brei" (TMDB 537518) has no runtime on TMDB. The Mediathek
    // offers the 85 min ZDF film and a 5 min "Die Maus" retelling.
    const brei: TmdbMovieData = {
      ...movie,
      title: "Der süße Brei",
      germanTitle: "Der süße Brei",
      runtime: null,
    };
    const clip = makeItem(300, "clip", { topic: "Die Maus", title: "Der süße Brei" });
    const film = makeItem(85 * 60, "film", { topic: "Märchenperlen", title: "Der süße Brei" });

    const matches = await matchMovieItems([clip, film], brei, 300);

    expect(matches.map((match) => match.item.url_video)).toEqual(["https://example.com/film.mp4"]);
  });

  it("rejects a news item that lists the film among others", async () => {
    // Steckerlfischfiasko (99 min) was imported as a 14 min tagesschau24 cinema
    // tip that names four films in its title.
    const steckerlfisch: TmdbMovieData = {
      ...movie,
      title: "Steckerlfischfiasko",
      germanTitle: "Steckerlfischfiasko",
      runtime: 99,
    };
    const tip = makeItem(14 * 60, "tip", {
      topic: "tagesschau24",
      title: 'KINO: "Steckerlfischfiasko", "Sunny Dancer", "Im Spiegel meiner Mutter"',
    });

    const matches = await matchMovieItems([tip], steckerlfisch, 300);

    expect(matches).toHaveLength(0);
  });
});

describe("matchMovieItems – part markers", () => {
  it("rejects one part of a serialised broadcast", async () => {
    // ARTE aired "Fabian oder Der Gang vor die Hunde" (176 min) as four parts.
    const fabian: TmdbMovieData = {
      ...movie,
      title: "Fabian oder der Gang vor die Hunde",
      germanTitle: "Fabian oder der Gang vor die Hunde",
      runtime: 176,
    };
    const part = makeItem(2580, "part", {
      topic: "Fernsehfilme und Serien - Serien",
      title:
        "Fabian oder Der Gang vor die Hunde (1/4) - Die Zeit ist mit den Engeln böse (Audiodeskription)",
    });

    const matches = await matchMovieItems([part], fabian, 300);

    expect(matches).toHaveLength(0);
  });
});

describe("matchMovieItems – title relation", () => {
  it("does not match a title that merely shares a word stem", async () => {
    // The hr documentary "Milky Chance ..." was grabbed as the film "Milk"
    // because a plain includes() matched inside the word.
    const milk: TmdbMovieData = {
      ...movie,
      title: "Milk",
      germanTitle: "Milk",
      runtime: 128,
    };
    const milkyChance = makeItem(86 * 60, "milky", {
      topic: 'Milky Chance - "Two High School Friends Making Music"',
      title: 'Milky Chance – "Two High School Friends Making Music" (DE)',
    });

    const matches = await matchMovieItems([milkyChance], milk, 300);

    expect(matches).toHaveLength(0);
  });

  it("matches through a broadcast annotation", async () => {
    // "Lost Country (Originalversion mit Untertitel)" is the film itself.
    const lostCountry: TmdbMovieData = {
      ...movie,
      title: "Изгубљена земља",
      germanTitle: "Lost Country",
      runtime: 98,
    };
    const item = makeItem(6032, "lost", {
      topic: "Kino - Filme",
      title: "Lost Country (Originalversion mit Untertitel)",
    });

    const matches = await matchMovieItems([item], lostCountry, 300);

    expect(matches).toHaveLength(1);
    expect(matches[0].titleMatch).toBe("exact");
  });
});

describe("matchMovieItems – partial title", () => {
  it("matches a film whose broadcast title adds a subtitle after a dot", async () => {
    // ARD titles the Eberhofer films "Dampfnudelblues. Ein Eberhoferkrimi".
    const dampfnudel: TmdbMovieData = {
      ...movie,
      title: "Dampfnudelblues",
      germanTitle: "Dampfnudelblues",
      runtime: 87,
    };
    const item = makeItem(87 * 60, "film", {
      topic: "Filme in der ARD",
      title: "Dampfnudelblues. Ein Eberhoferkrimi",
    });

    const matches = await matchMovieItems([item], dampfnudel, 300);

    expect(matches).toHaveLength(1);
  });
});

describe("matchMovieItems – partial title position", () => {
  const wickie: TmdbMovieData = {
    ...movie,
    title: "Wickie und die starken Männer",
    germanTitle: "Wickie und die starken Männer",
    runtime: 85,
  };

  it("rejects a magazine piece that puts the film behind a headline", async () => {
    const piece = makeItem(57 * 60, "piece", {
      topic: "Tigerenten Club",
      title: "Endlich im Kino: Wickie und die starken Männer",
    });

    const matches = await matchMovieItems([piece], wickie, 300);

    expect(matches).toHaveLength(0);
  });

  it("accepts a title in typographic quotes", async () => {
    const shaun: TmdbMovieData = {
      ...movie,
      title: "Shaun the Sheep Movie",
      germanTitle: "Shaun das Schaf - Der Film",
      runtime: 85,
    };
    const item = makeItem(82 * 60, "shaun", {
      topic: "Film",
      title: "«Shaun das Schaf – Der Film» – Lustiges Abenteuer für die ganze Familie",
    });

    const matches = await matchMovieItems([item], shaun, 300);

    expect(matches).toHaveLength(1);
  });

  it("accepts an episode title that continues the series topic", async () => {
    const camping: TmdbMovieData = {
      ...movie,
      title: "Familie Bundschuh - Wir machen Camping",
      germanTitle: "Familie Bundschuh - Wir machen Camping",
      runtime: 90,
    };
    const item = makeItem(89 * 60, "camping", {
      topic: "Familie Bundschuh",
      title: "Wir machen Camping - Komödie frei nach der Roman-Reihe von Andrea Sawatzki (S01/E09)",
    });

    const matches = await matchMovieItems([item], camping, 300);

    expect(matches).toHaveLength(1);
  });
});

describe("matchMovieItems – original title", () => {
  const starWars: TmdbMovieData = {
    ...movie,
    title: "Star Wars",
    germanTitle: "Krieg der Sterne",
    runtime: 121,
  };

  it("does not take a programme that merely mentions the original title", async () => {
    // A 127 min film podcast passes the runtime band, but German broadcasters
    // would title the film itself "Krieg der Sterne".
    const podcast = makeItem(127 * 60, "podcast", {
      topic: "Cinema Strikes Back",
      title: "So macht STAR WARS Spaß! AHSOKA Kritik / Folge 5 & 6",
    });

    const matches = await matchMovieItems([podcast], starWars, 300);

    expect(matches).toHaveLength(0);
  });

  it("still matches a broadcast titled exactly by the original title", async () => {
    const film = makeItem(121 * 60, "film", { topic: "Spielfilm", title: "Star Wars" });

    const matches = await matchMovieItems([film], starWars, 300);

    expect(matches).toHaveLength(1);
  });
});

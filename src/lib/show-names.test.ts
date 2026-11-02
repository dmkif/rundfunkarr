import { describe, it, expect } from "vitest";
import { withoutYearSuffix } from "./show-names";

describe("withoutYearSuffix", () => {
  it("drops TVDB's disambiguation year", () => {
    expect(withoutYearSuffix("Die Schlümpfe (2021)")).toBe("Die Schlümpfe");
  });

  it("leaves names without a year alone", () => {
    expect(withoutYearSuffix("Shaun das Schaf")).toBe("Shaun das Schaf");
    expect(withoutYearSuffix("Soko Kitzbühel (8/15)")).toBe("Soko Kitzbühel (8/15)");
  });
});

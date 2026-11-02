import { describe, it, expect } from "vitest";
import { titleMatchKey } from "./mediathek/title-parsing";

describe("titleMatchKey", () => {
  it("treats broadcaster and TVDB punctuation of multi-part titles alike", () => {
    expect(titleMatchKey("Schlumpf in die Zukunft, Teil 1")).toBe(
      titleMatchKey("Schlumpf in die Zukunft - Teil 1")
    );
  });

  it("keeps the part number apart", () => {
    expect(titleMatchKey("Schlumpf in die Zukunft, Teil 1")).not.toBe(
      titleMatchKey("Schlumpf in die Zukunft - Teil 2")
    );
  });

  it("ignores ellipsis style and case", () => {
    expect(titleMatchKey("Wer einmal lügt ...")).toBe(titleMatchKey("Wer einmal Lügt…"));
  });
});

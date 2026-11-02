/**
 * TVDB disambiguates remakes with a year ("Die Schlümpfe (2021)"); broadcasters
 * never put it in the topic, and MediathekView finds nothing with it.
 */
export function withoutYearSuffix(name: string): string {
  return name.replace(/\s*\(\d{4}\)\s*$/, "");
}

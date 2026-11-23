// BOS-2337: the "Your review" lane (every ticket whose next step is the owner's) comes first when it has
// cards, so it is not off the right edge at common window sizes. With no cards the order is unchanged.
export function yourReviewFirst<T extends { mine: boolean; tickets: readonly unknown[] }>(lanes: T[]): T[] {
  const i = lanes.findIndex((l) => l.mine);
  if (i <= 0 || lanes[i]!.tickets.length === 0) return lanes;
  return [lanes[i]!, ...lanes.slice(0, i), ...lanes.slice(i + 1)];
}

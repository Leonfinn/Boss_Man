/** BOS-1942: where a check runs, in one wording for both Merge queue tabs. `ranOn` is the server's value: a check worker's name, or "company runner" for the server itself. */
export const SERVER_PLACE = "company runner";

/** The place as a phrase: "the check worker Truenas", or "this server (Docker01)" with the host's own name when Boss Man records one. */
function placePhrase(ranOn: string, serverHost?: string | null): string {
  if (ranOn !== SERVER_PLACE) return `the check worker ${ranOn}`;
  return serverHost ? `this server (${serverHost})` : "this server";
}

/** "Running on the check worker Truenas." / "Running on this server (Docker01)."; null when the place isn't known. */
export function runningOnText(ranOn: string | null | undefined, serverHost?: string | null): string | null {
  return ranOn ? `Running on ${placePhrase(ranOn, serverHost)}.` : null;
}

/** For a merge whose check is over and waits for GitHub CI: "Check done on this server (Docker01)." */
export function checkDoneOnText(ranOn: string | null | undefined, serverHost?: string | null): string | null {
  return ranOn ? `Check done on ${placePhrase(ranOn, serverHost)}.` : null;
}

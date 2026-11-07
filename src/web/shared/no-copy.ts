// What the home page says when there is no demo copy to show (a cap was hit, or the Worker could not make one).
/** The line under the fans number on each card, instead of "Seating the starting fans…". */
export function noCopyLine(status: number | null): string {
  return status === 429
    ? "No demo copy right now (today’s limit is reached). Enter a judge code below, or come back later."
    : "No demo copy right now (the sample shows could not start). Try again in a minute, or start your own show.";
}
/** Why a judge button is off while there is no copy. */
export const NO_COPY_HINT = "Needs a demo copy. There isn’t one right now: enter a judge code below, or come back later.";

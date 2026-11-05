import { StationBoard } from "./station-board";

/**
 * Screen 7 — KDS Station View.
 *
 * Unwraps the dynamic station segment server-side (App Router params are a
 * Promise) and hands a plain string to the board.
 */
export default async function KdsStationPage({ params }: { params: Promise<{ station: string }> }) {
  const { station } = await params;
  return <StationBoard station={station} />;
}

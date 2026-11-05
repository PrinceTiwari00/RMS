import type { Metadata } from "next";
import { GuestOrdering } from "./guest-ordering";

export const metadata: Metadata = {
  title: "Table ordering — Terai Kitchen & Bar",
  description: "Browse the menu, order to your table and follow your food to the pass.",
};

interface GuestPageProps {
  params: Promise<{ token: string }>;
}

/** Public, token-scoped table ordering. No staff session is required. */
export default async function GuestPage({ params }: GuestPageProps) {
  const { token } = await params;
  return <GuestOrdering token={token} />;
}

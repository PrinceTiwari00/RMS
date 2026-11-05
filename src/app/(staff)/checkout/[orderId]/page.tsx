import { CheckoutView } from "./checkout-view";

/**
 * Screen 5 — Payment & Checkout.
 *
 * `params` is a Promise in the App Router, so this server component unwraps it
 * and hands a plain string to the client view.
 */
export default async function CheckoutPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return <CheckoutView orderId={orderId} />;
}

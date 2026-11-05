import type { Metadata, Viewport } from "next";
import "./globals.css";
import { StoreProvider } from "@/lib/store";
import { ToastHost } from "@/components/ui";

export const metadata: Metadata = {
  title: "Terai Kitchen & Bar — Restaurant Management System",
  description:
    "Multi-role restaurant management: front-of-house POS and floor plan, back-of-house kitchen display, and the full back-office portal for menu, inventory, labour and analytics.",
  applicationName: "RMS",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0f6f66",
};

/**
 * Root layout.
 *
 * The store provider wraps every route so the shell, the PIN pad and the
 * customer-facing display all share one bootstrap fetch. The layout itself stays
 * a server component — only the provider and the toast host are client code.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>
          {children}
          <ToastHost />
        </StoreProvider>
      </body>
    </html>
  );
}

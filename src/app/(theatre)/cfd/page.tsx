import { Suspense } from "react";
import { CfdDisplay } from "./cfd-display";

/**
 * Customer-facing till display. The client reads the optional terminal query
 * parameter inside Suspense so this route remains compatible with a production
 * Next.js build.
 */
export default function CfdPage() {
  return (
    <Suspense
      fallback={
        <div className="stage flex min-h-screen items-center justify-center text-sm font-semibold text-stage-soft">
          Starting customer display…
        </div>
      }
    >
      <CfdDisplay />
    </Suspense>
  );
}

import { redirect } from "next/navigation";

/** Provision all new restaurants through the tenant-aware platform workflow. */
export default function SetupPage() {
  redirect("/platform");
}

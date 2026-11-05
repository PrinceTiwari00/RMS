/** Runtime enforcement for configurable manager-PIN approvals. */
import { can, type Permission } from "@/domain/permissions";
import { forbidden } from "@/server/router";
import { getSettings } from "@/server/settings";
import { verifyManagerPin } from "@/server/staff";
import type { SessionUser } from "@/types";

export function authorizeSensitiveAction(
  actor: SessionUser,
  action: "void" | "discount" | "comp",
  managerPin?: string,
): SessionUser | null {
  const settings = getSettings();
  const capability: Permission = action === "void" ? "pos.void" : "pos.discount";
  const approvalRequired =
    action === "void" ? settings.managerPinForVoid : action === "discount" ? settings.managerPinForDiscount : settings.managerPinForComp;
  const managerSession = can(actor.permissions, "admin.users");
  const capable = can(actor.permissions, capability) || managerSession;

  if (!approvalRequired && !capable) throw forbidden(`missing permission: ${capability}`);
  if (approvalRequired && !managerSession) return verifyManagerPin(managerPin ?? "");
  return null;
}

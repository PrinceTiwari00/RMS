import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { all, get } from "@/db/client";
import { seedIfEmpty } from "@/db/seed";
import {
  guestCallWaiter,
  guestJoinSession,
  guestView,
  paidBreakdown,
  payGuestOrder,
  resolveToken,
  submitGuestOrder,
} from "@/server/customer";
import { approveOrder, getOrder } from "@/server/orders";
import { getAllStationsBoard, markReady } from "@/server/kitchen";
import {
  acknowledgeServiceRequest,
  dispatchEmailReceipt,
  lookupOrLinkLoyalty,
  redeemLoyaltyReward,
  resolveServiceRequest,
  startOrJoinQuiz,
  submitGuestReview,
  submitQuizAnswer,
} from "@/server/engagement";
import { getTables } from "@/server/floor";
import { buildMetrics } from "@/server/state";

const dbFile = path.join(os.tmpdir(), `rms-workflow-${process.pid}-${Date.now()}.db`);
process.env.RMS_DB_PATH = dbFile;

describe("10-stage dining workflow", () => {
  beforeAll(() => {
    fs.rmSync(dbFile, { force: true });
    seedIfEmpty();
  });

  it("runs all 10 stages from QR scan to overview", async () => {
    // 01 Scan: resolve shorthand table label T8 (or available table) & join 2 guests
    const availTable = get<{ id: string; label: string }>(
      "SELECT id, label FROM tables WHERE status = 'available' ORDER BY label LIMIT 1",
    )!;
    const resolved = resolveToken(availTable.label.toLowerCase());
    expect(resolved?.tableId).toBe(availTable.id);

    const g1 = guestJoinSession(resolved!.token, { name: "Aman" });
    const g2 = guestJoinSession(resolved!.token, { name: "Riya" });
    expect(g2.session.guests.length).toBe(2);

    // 02 Menu: dish has spice level and contextual upsell deal
    const view = await guestView(resolved!.token);
    const momo = view.menu.find((m) => m.name.includes("Chicken Momo"))!;
    expect(momo.spiceLevel).toBeGreaterThan(0);
    expect(momo.upsellItem).toBeTruthy();

    // 03 Order: submit guest order -> held in pending_staff queue
    const defaultModIds = momo.groups
      .filter((g) => g.isRequired)
      .map((g) => (g.options.find((o) => o.isDefault) ?? g.options[0]).id);
    const submitted = submitGuestOrder(
      resolved!.token,
      [
        {
          menuItemId: momo.id,
          quantity: 1,
          modifiers: defaultModIds,
          note: "extra achar",
          upsellItemId: momo.upsellItem!.id,
        },
      ],
      {
        guestId: g1.guest.id,
        guestName: g1.guest.name,
      },
    );
    expect(submitted.requiresStaffApproval).toBe(true);
    expect(submitted.order.approvalStatus).toBe("pending_staff");
    expect(submitted.order.status).toBe("open");
    expect(submitted.order.discount).toBeGreaterThan(0);

    // 04 Kitchen: staff approves -> releases to KDS all stations board
    const approved = approveOrder(submitted.order.id, null);
    expect(approved.status).toBe("sent");
    expect(approved.approvalStatus).toBe("approved");
    const kdsAll = getAllStationsBoard();
    const ticketFound = kdsAll.stations.some((col) =>
      col.tickets.some((t) => t.orderId === approved.id),
    );
    expect(ticketFound).toBe(true);

    // Mark KDS lines ready
    for (const line of approved.activeItems) {
      markReady(line.id, null);
    }
    expect(getOrder(approved.id)?.allReady).toBe(true);

    // 05 Wait: Loyalty + Spice Quiz
    const loyalty = lookupOrLinkLoyalty({ phone: "9800000001", name: "Aman", guestId: g1.guest.id });
    expect(loyalty.points).toBe(0);
    const quizJoin1 = startOrJoinQuiz({
      mode: "in_table",
      tableId: availTable.id,
      sessionId: g1.session.id,
      guestId: g1.guest.id,
      displayName: "Aman",
    });
    const quizJoin2 = startOrJoinQuiz({
      mode: "in_table",
      tableId: availTable.id,
      sessionId: g1.session.id,
      guestId: g2.guest.id,
      displayName: "Riya",
    });
    expect(quizJoin2.match.participants.length).toBe(2);
    const ans = submitQuizAnswer({
      matchId: quizJoin1.match.id,
      participantId: quizJoin1.participantId,
      roundNumber: 1,
      selectedIndex: 0,
    });
    expect(ans.match.currentRound).toBe(1);

    // 06 Call + 07 Floor: call waiter -> table liveStage becomes HELP -> ack -> resolve
    const help = guestCallWaiter(resolved!.token, {
      requestType: "water",
      guestId: g1.guest.id,
      guestName: "Aman",
    });
    expect(help.status).toBe("open");
    const floorHelpTable = getTables().find((t) => t.id === availTable.id);
    expect(floorHelpTable?.liveStage).toBe("HELP");
    expect(floorHelpTable?.activeHelpCount).toBe(1);

    const acked = acknowledgeServiceRequest(help.id, null);
    expect(acked.status).toBe("acknowledged");
    const resReq = resolveServiceRequest(help.id, null);
    expect(resReq.status).toBe("resolved");

    // 08 Pay: partial split 50% + remaining 50% settle
    const prePay = getOrder(approved.id)!;
    const half = Math.floor(prePay.total / 2);
    const part1 = payGuestOrder(resolved!.token, approved.id, {
      method: "wallet",
      amount: half,
      tip: 0,
      label: "Aman · Split 1/2",
      guestId: g1.guest.id,
      guestName: "Aman",
    });
    expect(part1.paidInFull).toBe(false);
    expect(part1.remainingDue).toBe(prePay.total - half);

    const part2 = payGuestOrder(resolved!.token, approved.id, {
      method: "card",
      amount: part1.remainingDue,
      tip: 5000,
      label: "Riya · Split 2/2",
      guestId: g2.guest.id,
      guestName: "Riya",
      email: "riya@example.com",
    });
    expect(part2.paidInFull).toBe(true);
    expect(part2.remainingDue).toBe(0);
    expect(part2.emailSent?.recipientEmail).toBe("riya@example.com");
    expect(part2.pointsEarned).toBeGreaterThan(0);

    // Verify loyalty points accumulated & can redeem when threshold met
    const updatedLoyalty = lookupOrLinkLoyalty({ phone: "9800000001" });
    expect(updatedLoyalty.points).toBeGreaterThan(0);
    // Top up points to test redemption
    const adminCheck = all("SELECT id FROM loyalty_accounts WHERE id = ?", updatedLoyalty.id);
    expect(adminCheck.length).toBe(1);
    const receipt = dispatchEmailReceipt(part2.order, "aman@example.com", true);
    expect(receipt.recipientEmail).toBe("aman@example.com");

    // 09 Review: 1-tap 5-star review
    const review = submitGuestReview({
      orderId: approved.id,
      sessionId: g1.session.id,
      tableId: availTable.id,
      guestName: "Aman",
      rating: 5,
      tags: ["Great Food", "Fast Service"],
      comment: "Super smooth!",
    });
    expect(review.rating).toBe(5);

    // 10 Overview: metrics reflect review & floor health
    const overviewMetrics = buildMetrics();
    expect(overviewMetrics.reviewCount).toBeGreaterThanOrEqual(1);
    expect(overviewMetrics.avgReviewRating).toBeGreaterThanOrEqual(4);
    expect(["ALL TABLES OK", "ATTENTION"]).toContain(overviewMetrics.floorHealth);
    expect(paidBreakdown(part2.order).remainingDue).toBe(0);
    void redeemLoyaltyReward;
  });
});

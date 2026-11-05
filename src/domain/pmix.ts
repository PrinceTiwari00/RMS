/**
 * Product Mix (Menu Engineering) report — the Kasavana/Smith matrix.
 *
 * Each item is plotted on two axes over the reporting period:
 *   • Popularity  — its share of total units sold vs. 70% of an equal share
 *   • Profitability — its contribution margin vs. the average contribution margin
 *
 * giving the four classic quadrants:
 *   Star       high popularity, high margin   → protect, keep prominent
 *   Plowhorse  high popularity, low margin    → reprice or shrink the portion
 *   Puzzle     low popularity,  high margin   → promote, rename, reposition
 *   Dog        low popularity,  low margin    → consider removing
 */

export interface PmixInput {
  id: string;
  name: string;
  category?: string;
  unitsSold: number;
  revenue: number; // paisa
  cost: number; // paisa (theoretical, from the BOM)
  price: number; // paisa
}

export type Quadrant = "star" | "plowhorse" | "puzzle" | "dog";

export interface PmixRow extends PmixInput {
  contributionMargin: number;
  marginPercent: number;
  menuMixPercent: number;
  foodCostPercent: number;
  popular: boolean;
  profitable: boolean;
  quadrant: Quadrant;
  totalContribution: number;
}

export interface PmixResult {
  rows: PmixRow[];
  totals: {
    units: number;
    revenue: number;
    cost: number;
    contribution: number;
    marginPercent: number;
    foodCostPercent: number;
  };
  thresholds: { popularityPercent: number; contributionMargin: number };
  quadrants: Record<Quadrant, { count: number; rows: PmixRow[] }>;
}

export const QUADRANT_META: Record<Quadrant, { label: string; blurb: string; action: string }> = {
  star: {
    label: "Stars",
    blurb: "High popularity · high margin",
    action: "Protect the recipe and keep them prominent on the menu.",
  },
  plowhorse: {
    label: "Plowhorses",
    blurb: "High popularity · low margin",
    action: "Reprice, shrink the portion, or renegotiate the ingredient cost.",
  },
  puzzle: {
    label: "Puzzles",
    blurb: "Low popularity · high margin",
    action: "Promote them, rename, or move them to a better spot on the page.",
  },
  dog: {
    label: "Dogs",
    blurb: "Low popularity · low margin",
    action: "Candidates for removal or a full rework.",
  },
};

/** 70% of an equal share is the classic popularity cut-off. */
export const POPULARITY_FACTOR = 0.7;

export function quadrantFor(popular: boolean, profitable: boolean): Quadrant {
  if (popular && profitable) return "star";
  if (popular && !profitable) return "plowhorse";
  if (!popular && profitable) return "puzzle";
  return "dog";
}

export function productMix(items: PmixInput[]): PmixResult {
  const totalUnits = items.reduce((total, item) => total + item.unitsSold, 0);
  const rows: PmixRow[] = items.map((item) => {
    const contributionMargin = item.revenue - item.cost;
    const menuMixPercent = totalUnits ? round2((item.unitsSold / totalUnits) * 100) : 0;
    return {
      ...item,
      contributionMargin,
      totalContribution: contributionMargin,
      marginPercent: item.revenue ? round2((contributionMargin / item.revenue) * 100) : 0,
      foodCostPercent: item.revenue ? round2((item.cost / item.revenue) * 100) : 0,
      menuMixPercent,
      popular: false,
      profitable: false,
      quadrant: "dog",
    };
  });

  const popularityThreshold = items.length ? round2((100 / items.length) * POPULARITY_FACTOR) : 0;
  const soldRows = rows.filter((row) => row.unitsSold > 0);
  const averageContribution = soldRows.length
    ? soldRows.reduce((total, row) => total + row.contributionMargin, 0) / soldRows.length
    : 0;

  for (const row of rows) {
    row.popular = row.menuMixPercent >= popularityThreshold && row.unitsSold > 0;
    row.profitable = row.contributionMargin > averageContribution;
    row.quadrant = quadrantFor(row.popular, row.profitable);
  }

  rows.sort((left, right) => right.contributionMargin - left.contributionMargin);

  const totals = {
    units: totalUnits,
    revenue: rows.reduce((total, row) => total + row.revenue, 0),
    cost: rows.reduce((total, row) => total + row.cost, 0),
    contribution: rows.reduce((total, row) => total + row.contributionMargin, 0),
    marginPercent: 0,
    foodCostPercent: 0,
  };
  totals.marginPercent = totals.revenue ? round2((totals.contribution / totals.revenue) * 100) : 0;
  totals.foodCostPercent = totals.revenue ? round2((totals.cost / totals.revenue) * 100) : 0;

  const quadrants = {
    star: { count: 0, rows: [] as PmixRow[] },
    plowhorse: { count: 0, rows: [] as PmixRow[] },
    puzzle: { count: 0, rows: [] as PmixRow[] },
    dog: { count: 0, rows: [] as PmixRow[] },
  } as Record<Quadrant, { count: number; rows: PmixRow[] }>;
  for (const row of rows) {
    quadrants[row.quadrant].rows.push(row);
    quadrants[row.quadrant].count += 1;
  }

  return { rows, totals, thresholds: { popularityPercent: popularityThreshold, contributionMargin: Math.round(averageContribution) }, quadrants };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

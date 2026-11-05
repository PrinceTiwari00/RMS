/**
 * Demo seed — a complete single-store restaurant in Birgunj, Nepal.
 *
 * Everything is generated from a fixed seed so the workspace is reproducible:
 * staff with PINs, a floor plan with geometry, a full menu with nested modifier
 * groups, inventory with a bill of materials, vendors, live tickets on the floor
 * and in the kitchen, a waitlist, a published week of shifts, and fourteen days
 * of closed history so the executive dashboard, P-Mix and Z-report have real
 * numbers to work with.
 *
 * Money is integer paisa throughout (1 NPR = 100 paisa).
 */
import { all, get, run, tx, uuid, migrate } from "@/db/client";
import { random, type Random } from "@/lib/rng";
import { shiftDate, today, zoned, atClock, businessDateNow } from "@/domain/time";
import { seedHistory } from "./seed-history";
import { seedCoreRoles, seedCoreStations } from "./core";
import {
  seedHosting,
  seedInventoryOps,
  seedLiveService,
  seedPurchasing,
  seedScheduling,
} from "./seed-ops";

export const SEED_VERSION = "rms-demo-v2";

// ------------------------------------------------------------------- settings
const SETTINGS: Record<string, string> = {
  restaurant_name: "Terai Kitchen & Bar",
  restaurant_tagline: "Nepali · Indian · Continental",
  legal_tax_entity: "Terai Hospitality Pvt. Ltd.",
  website: "https://teraikitchen.np",
  time_zone: "Asia/Kathmandu",
  address: "Chhapaiya Road, Birgunj 44700, Madhesh, Nepal",
  phone: "+977 981 234 5678",
  pan_vat: "402198745",
  currency: "NPR",
  currency_symbol: "Rs",
  locale: "en-IN",
  vat_rate: "13",
  vat_inclusive: "0",
  service_charge_rate: "10",
  tip_presets: "15,18,20,25",
  cash_float: "1500000", // Rs 15,000 opening float in paisa
  business_day_rollover: "4",
  kds_warn_minutes: "8",
  kds_late_minutes: "15",
  labor_target_min: "15",
  labor_target_max: "22",
  store_forward_limit: "5000000", // Rs 50,000 offline card risk cap
  receipt_footer: "Thank you! Dhanyabad. VAT 13% included as applicable.",
  qr_ordering_enabled: "1",
  cfd_enabled: "1",
  seed_version: SEED_VERSION,
};

interface RoleRow {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------- staff
const STAFF: { name: string; role: string; pin: string; color: string; phone: string }[] = [
  { name: "Rajesh Kumar Sah", role: "manager", pin: "2468", color: "#137c70", phone: "+977 981 000 1001" },
  { name: "Sunita Devi Yadav", role: "manager", pin: "1357", color: "#8a5aa8", phone: "+977 981 000 1002" },
  { name: "Anil Prasad Gupta", role: "server", pin: "1111", color: "#c2542f", phone: "+977 981 000 2001" },
  { name: "Pooja Kumari Singh", role: "server", pin: "2222", color: "#3d6ea8", phone: "+977 981 000 2002" },
  { name: "Mohammad Irfan Ansari", role: "server", pin: "3333", color: "#3f8f5f", phone: "+977 981 000 2003" },
  { name: "Bikash Chaudhary", role: "cashier", pin: "4444", color: "#c98a1e", phone: "+977 981 000 3001" },
  { name: "Sita Ram Mishra", role: "cook", pin: "5555", color: "#bd594b", phone: "+977 981 000 4001" },
  { name: "Deepak Thakur", role: "cook", pin: "6666", color: "#2f7d8c", phone: "+977 981 000 4002" },
  { name: "Kiran Patel", role: "expo", pin: "7777", color: "#5a6b78", phone: "+977 981 000 5001" },
  { name: "Nisha Khatun", role: "bartender", pin: "8888", color: "#a8546f", phone: "+977 981 000 6001" },
  { name: "Aarati Sharma", role: "host", pin: "9999", color: "#6a8f3f", phone: "+977 981 000 7001" },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

// ------------------------------------------------------------------ floor plan
const SECTIONS = [
  { id: "sec-main", name: "Main Dining", color: "#137c70" },
  { id: "sec-terrace", name: "Terrace", color: "#c98a1e" },
  { id: "sec-bar", name: "Bar Lounge", color: "#3d6ea8" },
  { id: "sec-private", name: "Private Room", color: "#8a5aa8" },
];

interface TableSeed {
  label: string;
  section: string;
  capacity: number;
  shape: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
}

const TABLES: TableSeed[] = [
  // Main dining — 4x2 grid of round tables
  { label: "M1", section: "sec-main", capacity: 2, shape: "round", x: 6, y: 8, w: 11, h: 15 },
  { label: "M2", section: "sec-main", capacity: 4, shape: "square", x: 21, y: 8, w: 14, h: 15 },
  { label: "M3", section: "sec-main", capacity: 4, shape: "square", x: 38, y: 8, w: 14, h: 15 },
  { label: "M4", section: "sec-main", capacity: 6, shape: "rect", x: 55, y: 8, w: 20, h: 15 },
  { label: "M5", section: "sec-main", capacity: 2, shape: "round", x: 6, y: 34, w: 11, h: 15 },
  { label: "M6", section: "sec-main", capacity: 4, shape: "square", x: 21, y: 34, w: 14, h: 15 },
  { label: "M7", section: "sec-main", capacity: 4, shape: "square", x: 38, y: 34, w: 14, h: 15 },
  { label: "M8", section: "sec-main", capacity: 8, shape: "rect", x: 55, y: 34, w: 20, h: 15 },
  // Booths along the right wall
  { label: "B1", section: "sec-main", capacity: 4, shape: "booth", x: 80, y: 8, w: 14, h: 13 },
  { label: "B2", section: "sec-main", capacity: 4, shape: "booth", x: 80, y: 25, w: 14, h: 13 },
  { label: "B3", section: "sec-main", capacity: 6, shape: "booth", x: 80, y: 42, w: 14, h: 13 },
  // Terrace
  { label: "T1", section: "sec-terrace", capacity: 2, shape: "round", x: 8, y: 64, w: 11, h: 14 },
  { label: "T2", section: "sec-terrace", capacity: 4, shape: "round", x: 24, y: 64, w: 13, h: 14 },
  { label: "T3", section: "sec-terrace", capacity: 4, shape: "round", x: 42, y: 64, w: 13, h: 14 },
  { label: "T4", section: "sec-terrace", capacity: 6, shape: "rect", x: 60, y: 64, w: 18, h: 14 },
  { label: "T5", section: "sec-terrace", capacity: 2, shape: "round", x: 82, y: 64, w: 11, h: 14 },
  // Bar lounge — bar stools + low tables
  { label: "BR", section: "sec-bar", capacity: 6, shape: "bar", x: 8, y: 87, w: 44, h: 9 },
  { label: "L1", section: "sec-bar", capacity: 3, shape: "round", x: 58, y: 84, w: 10, h: 12 },
  { label: "L2", section: "sec-bar", capacity: 3, shape: "round", x: 72, y: 84, w: 10, h: 12 },
  { label: "L3", section: "sec-bar", capacity: 4, shape: "round", x: 86, y: 84, w: 10, h: 12 },
  // Private room
  { label: "P1", section: "sec-private", capacity: 12, shape: "rect", x: 82, y: 25, w: 0, h: 0 },
];

// ----------------------------------------------------------------------- menu
interface ModifierGroupSeed {
  name: string;
  min: number;
  max: number;
  required: boolean;
  options: { name: string; price: number; isDefault?: boolean }[];
}

interface MenuItemSeed {
  name: string;
  category: string;
  price: number; // NPR
  course: "appetizer" | "entree" | "drink" | "dessert";
  station: string;
  emoji: string;
  description: string;
  allergens?: string;
  prep?: number;
  groups?: ModifierGroupSeed[];
  featured?: boolean;
}

const CATEGORIES = [
  { id: "cat-starters", name: "Starters", icon: "🥟", color: "#c2542f" },
  { id: "cat-tandoor", name: "Tandoor", icon: "🔥", color: "#bd594b" },
  { id: "cat-thakali", name: "Thakali & Curries", icon: "🍛", color: "#c98a1e" },
  { id: "cat-noodles", name: "Noodles & Rice", icon: "🍜", color: "#3f8f5f" },
  { id: "cat-western", name: "Pizza & Burgers", icon: "🍕", color: "#8a5aa8" },
  { id: "cat-dessert", name: "Desserts", icon: "🍨", color: "#a8546f" },
  { id: "cat-beverages", name: "Beverages", icon: "🥤", color: "#3d6ea8" },
  { id: "cat-bar", name: "Bar", icon: "🍺", color: "#2f7d8c" },
];

const MOMO_GROUPS: ModifierGroupSeed[] = [
  {
    name: "Portion size",
    min: 1,
    max: 1,
    required: true,
    options: [
      { name: "Half plate · 5 pcs", price: -120 },
      { name: "Full plate · 10 pcs", price: 0, isDefault: true },
      { name: "Jumbo plate · 15 pcs", price: 150 },
    ],
  },
  {
    name: "Dipping achar",
    min: 1,
    max: 2,
    required: true,
    options: [
      { name: "Tomato achar", price: 0, isDefault: true },
      { name: "Sesur (sesame) achar", price: 0 },
      { name: "Extra hot chilli achar", price: 40 },
    ],
  },
];

const SPICE_GROUP: ModifierGroupSeed = {
  name: "Spice level",
  min: 1,
  max: 1,
  required: true,
  options: [
    { name: "Mild", price: 0 },
    { name: "Medium", price: 0, isDefault: true },
    { name: "Hot", price: 0 },
    { name: "Extra hot", price: 0 },
  ],
};

const BEVERAGE_GROUPS: ModifierGroupSeed[] = [
  {
    name: "Sugar",
    min: 0,
    max: 1,
    required: false,
    options: [
      { name: "Regular sugar", price: 0, isDefault: true },
      { name: "Less sugar", price: 0 },
      { name: "No sugar", price: 0 },
    ],
  },
  {
    name: "Size",
    min: 1,
    max: 1,
    required: true,
    options: [
      { name: "Regular", price: 0, isDefault: true },
      { name: "Large", price: 60 },
    ],
  },
];

const MENU: MenuItemSeed[] = [
  // Starters
  { name: "Chicken Momo (Steamed)", category: "cat-starters", price: 320, course: "appetizer", station: "pantry", emoji: "🥟", description: "Ten hand-folded steamed dumplings with tomato achar", allergens: "gluten, sesame", prep: 12, groups: MOMO_GROUPS, featured: true },
  { name: "Fried Momo", category: "cat-starters", price: 350, course: "appetizer", station: "fry", emoji: "🥟", description: "Crisp-fried chicken momo, sesame achar", allergens: "gluten, sesame, egg", prep: 12, groups: MOMO_GROUPS },
  { name: "Chilli Chicken", category: "cat-starters", price: 480, course: "appetizer", station: "grill", emoji: "🌶️", description: "Wok-tossed boneless chicken, capsicum, onion", allergens: "soy, gluten", prep: 14, groups: [SPICE_GROUP], featured: true },
  { name: "Vegetable Spring Roll", category: "cat-starters", price: 300, course: "appetizer", station: "fry", emoji: "🌯", description: "Six rolls, shredded cabbage and carrot", allergens: "gluten, soy", prep: 10 },
  { name: "Paneer Pakoda", category: "cat-starters", price: 340, course: "appetizer", station: "fry", emoji: "🧀", description: "Gram-flour fried paneer with mint chutney", allergens: "dairy, gluten", prep: 9 },
  { name: "Chicken Wings", category: "cat-starters", price: 420, course: "appetizer", station: "fry", emoji: "🍗", description: "Eight pieces, honey-chilli glaze", allergens: "soy, sesame", prep: 15, groups: [SPICE_GROUP] },

  // Tandoor
  { name: "Tandoori Chicken (Half)", category: "cat-tandoor", price: 620, course: "entree", station: "grill", emoji: "🔥", description: "Overnight yoghurt marinade, charcoal roasted", allergens: "dairy", prep: 22, groups: [SPICE_GROUP], featured: true },
  { name: "Chicken Tikka", category: "cat-tandoor", price: 580, course: "entree", station: "grill", emoji: "🍢", description: "Boneless tikka skewers with onion and lemon", allergens: "dairy", prep: 18 },
  { name: "Paneer Tikka", category: "cat-tandoor", price: 520, course: "entree", station: "grill", emoji: "🧀", description: "Charred paneer, capsicum, mint chutney", allergens: "dairy", prep: 16 },
  { name: "Tandoori Roti", category: "cat-tandoor", price: 40, course: "appetizer", station: "grill", emoji: "🫓", description: "Whole-wheat bread from the tandoor", allergens: "gluten", prep: 4 },
  { name: "Butter Naan", category: "cat-tandoor", price: 70, course: "appetizer", station: "grill", emoji: "🫓", description: "Leavened naan brushed with butter", allergens: "gluten, dairy", prep: 5 },

  // Thakali & curries
  { name: "Thakali Khana Set (Veg)", category: "cat-thakali", price: 480, course: "entree", station: "grill", emoji: "🍛", description: "Rice, dal, seasonal tarkari, achar, dahi", allergens: "dairy", prep: 15, groups: [
    { name: "Rice", min: 1, max: 1, required: true, options: [{ name: "White rice", price: 0, isDefault: true }, { name: "Brown rice", price: 60 }, { name: "Dhido (millet)", price: 40 }] },
    { name: "Add-ons", min: 0, max: 3, required: false, options: [{ name: "Extra dal", price: 60 }, { name: "Papad", price: 30 }, { name: "Extra achar", price: 30 }, { name: "Dahi", price: 70 }] },
  ], featured: true },
  { name: "Thakali Set (Chicken)", category: "cat-thakali", price: 620, course: "entree", station: "grill", emoji: "🍛", description: "Full set with chicken curry", allergens: "dairy", prep: 18, groups: [
    { name: "Rice", min: 1, max: 1, required: true, options: [{ name: "White rice", price: 0, isDefault: true }, { name: "Brown rice", price: 60 }, { name: "Dhido (millet)", price: 40 }] },
    { name: "Curry", min: 1, max: 2, required: true, options: [{ name: "Chicken curry", price: 0, isDefault: true }, { name: "Mutton curry", price: 230 }, { name: "Fish curry", price: 150 }] },
  ] },
  { name: "Butter Chicken", category: "cat-thakali", price: 680, course: "entree", station: "grill", emoji: "🍲", description: "Tomato-cashew gravy, finished with butter", allergens: "dairy, nuts", prep: 20, groups: [SPICE_GROUP] },
  { name: "Dal Bhat Tarkari", category: "cat-thakali", price: 380, course: "entree", station: "grill", emoji: "🥘", description: "The everyday Nepali plate, refills free", allergens: "", prep: 12 },
  { name: "Mutton Curry", category: "cat-thakali", price: 850, course: "entree", station: "grill", emoji: "🍖", description: "Slow-braised bone-in mutton", allergens: "", prep: 25, groups: [SPICE_GROUP] },
  { name: "Paneer Butter Masala", category: "cat-thakali", price: 540, course: "entree", station: "grill", emoji: "🧈", description: "Cottage cheese in a rich tomato gravy", allergens: "dairy, nuts", prep: 16 },

  // Noodles & rice
  { name: "Veg Chowmein", category: "cat-noodles", price: 280, course: "entree", station: "fry", emoji: "🍜", description: "Wok noodles with seasonal vegetables", allergens: "gluten, soy", prep: 10, groups: [SPICE_GROUP] },
  { name: "Chicken Chowmein", category: "cat-noodles", price: 350, course: "entree", station: "fry", emoji: "🍜", description: "Wok noodles with chicken and egg", allergens: "gluten, soy, egg", prep: 12, groups: [SPICE_GROUP], featured: true },
  { name: "Egg Fried Rice", category: "cat-noodles", price: 300, course: "entree", station: "fry", emoji: "🍚", description: "Steamed rice tossed with egg and spring onion", allergens: "egg, soy", prep: 10 },
  { name: "Chicken Biryani", category: "cat-noodles", price: 520, course: "entree", station: "grill", emoji: "🍛", description: "Sealed-pot basmati with saffron and raita", allergens: "dairy", prep: 22 },
  { name: "Mixed Schezwan Noodles", category: "cat-noodles", price: 420, course: "entree", station: "fry", emoji: "🌶️", description: "Chicken and prawn in schezwan sauce", allergens: "gluten, soy, shellfish", prep: 14, groups: [SPICE_GROUP] },

  // Pizza & burgers
  { name: "Margherita Pizza", category: "cat-western", price: 550, course: "entree", station: "grill", emoji: "🍕", description: "Mozzarella, tomato, basil, 10-inch", allergens: "gluten, dairy", prep: 16, groups: [
    { name: "Crust", min: 1, max: 1, required: true, options: [{ name: "Classic hand-tossed", price: 0, isDefault: true }, { name: "Thin crust", price: 0 }, { name: "Cheese-stuffed crust", price: 180 }] },
    { name: "Extra toppings", min: 0, max: 5, required: false, options: [{ name: "Extra mozzarella", price: 120 }, { name: "Mushroom", price: 90 }, { name: "Capsicum", price: 70 }, { name: "Olives", price: 90 }, { name: "Jalapeño", price: 90 }] },
  ] },
  { name: "Chicken Tikka Pizza", category: "cat-western", price: 720, course: "entree", station: "grill", emoji: "🍕", description: "Tandoori chicken, red onion, coriander", allergens: "gluten, dairy", prep: 18, groups: [
    { name: "Crust", min: 1, max: 1, required: true, options: [{ name: "Classic hand-tossed", price: 0, isDefault: true }, { name: "Thin crust", price: 0 }, { name: "Cheese-stuffed crust", price: 180 }] },
  ], featured: true },
  { name: "House Burger", category: "cat-western", price: 450, course: "entree", station: "grill", emoji: "🍔", description: "150g beef patty, house sauce, brioche bun", allergens: "gluten, egg, sesame", prep: 12, groups: [
    { name: "Cook temperature", min: 1, max: 1, required: true, options: [{ name: "Well done", price: 0 }, { name: "Medium well", price: 0, isDefault: true }, { name: "Medium", price: 0 }, { name: "Rare", price: 0 }] },
    { name: "Choose a side", min: 1, max: 2, required: true, options: [{ name: "Crispy fries", price: 0, isDefault: true }, { name: "Coleslaw", price: 60 }, { name: "Onion rings", price: 120 }, { name: "No side", price: -60 }] },
    { name: "Extras", min: 0, max: 4, required: false, options: [{ name: "Add cheese", price: 80 }, { name: "Add fried egg", price: 60 }, { name: "Extra patty", price: 220 }, { name: "No onion", price: 0 }, { name: "No tomato", price: 0 }] },
  ], featured: true },
  { name: "Chicken Burger", category: "cat-western", price: 520, course: "entree", station: "fry", emoji: "🍔", description: "Crumbed chicken thigh, slaw, chilli mayo", allergens: "gluten, egg", prep: 13, groups: [
    { name: "Choose a side", min: 1, max: 1, required: true, options: [{ name: "Crispy fries", price: 0, isDefault: true }, { name: "Coleslaw", price: 60 }, { name: "No side", price: -60 }] },
  ] },
  { name: "Crispy Fries", category: "cat-western", price: 220, course: "appetizer", station: "fry", emoji: "🍟", description: "Hand-cut, salted, with ketchup", allergens: "", prep: 7 },
  { name: "Cheesy Garlic Bread", category: "cat-western", price: 320, course: "appetizer", station: "grill", emoji: "🥖", description: "Baked with mozzarella and herb butter", allergens: "gluten, dairy", prep: 9 },

  // Desserts
  { name: "Gulab Jamun (2 pcs)", category: "cat-dessert", price: 180, course: "dessert", station: "dessert", emoji: "🍮", description: "Warm milk dumplings in cardamom syrup", allergens: "dairy, nuts", prep: 4 },
  { name: "Vanilla Ice Cream", category: "cat-dessert", price: 150, course: "dessert", station: "dessert", emoji: "🍨", description: "Two scoops, Nepali vanilla", allergens: "dairy", prep: 3 },
  { name: "Chocolate Brownie", category: "cat-dessert", price: 280, course: "dessert", station: "dessert", emoji: "🍫", description: "Warm brownie with ice cream", allergens: "dairy, egg, gluten, nuts", prep: 6 },
  { name: "Kheer", category: "cat-dessert", price: 200, course: "dessert", station: "dessert", emoji: "🍚", description: "Rice pudding, cashew and raisin", allergens: "dairy, nuts", prep: 4 },

  // Beverages
  { name: "Masala Chiya", category: "cat-beverages", price: 80, course: "drink", station: "bar", emoji: "☕", description: "Milk tea with ginger and cardamom", allergens: "dairy", prep: 5, groups: BEVERAGE_GROUPS },
  { name: "Fresh Lime Soda", category: "cat-beverages", price: 140, course: "drink", station: "bar", emoji: "🍋", description: "Sweet, salted or mixed", allergens: "", prep: 3, groups: [
    { name: "Style", min: 1, max: 1, required: true, options: [{ name: "Sweet", price: 0, isDefault: true }, { name: "Salted", price: 0 }, { name: "Mixed", price: 0 }] },
  ] },
  { name: "Mango Lassi", category: "cat-beverages", price: 220, course: "drink", station: "bar", emoji: "🥭", description: "Thick yoghurt shake with alphonso mango", allergens: "dairy", prep: 4 },
  { name: "Soft Drink", category: "cat-beverages", price: 120, course: "drink", station: "bar", emoji: "🥤", description: "Cola, lemon-lime or orange, 330ml", allergens: "", prep: 2 },
  { name: "Cold Coffee", category: "cat-beverages", price: 260, course: "drink", station: "bar", emoji: "🧋", description: "Blended with milk and ice", allergens: "dairy", prep: 5, groups: BEVERAGE_GROUPS },
  { name: "Mineral Water 1L", category: "cat-beverages", price: 60, course: "drink", station: "bar", emoji: "💧", description: "Sealed bottle", allergens: "", prep: 1 },

  // Bar
  { name: "Nepal Lager", category: "cat-bar", price: 450, course: "drink", station: "bar", emoji: "🍺", description: "330ml chilled bottle", allergens: "gluten", prep: 2 },
  { name: "Whisky 60ml", category: "cat-bar", price: 750, course: "drink", station: "bar", emoji: "🥃", description: "Single malt or blended, neat or on rocks", allergens: "", prep: 3, groups: [
    { name: "Mixer", min: 0, max: 1, required: false, options: [{ name: "Neat", price: 0, isDefault: true }, { name: "Soda", price: 60 }, { name: "Cola", price: 80 }, { name: "Water", price: 0 }] },
  ] },
  { name: "House Cocktail", category: "cat-bar", price: 650, course: "drink", station: "bar", emoji: "🍸", description: "Terai sunset — rum, citrus, bitters", allergens: "", prep: 5 },
  { name: "Virgin Mocktail", category: "cat-bar", price: 280, course: "drink", station: "bar", emoji: "🍹", description: "Passionfruit, lime and mint", allergens: "", prep: 4 },
];

// ------------------------------------------------------------------ inventory
interface InventorySeed {
  sku: string;
  name: string;
  category: string;
  unit: string;
  stock: number;
  /** NPR per base unit */
  cost: number;
  location: string;
  avgUse: number;
  maxUse: number;
  lead: number;
  maxLead: number;
  par: number;
  pack: number;
  vendor: string;
}

const INVENTORY: InventorySeed[] = [
  { sku: "MEAT-CHB-01", name: "Chicken breast", category: "meat", unit: "kg", stock: 61.1, cost: 48000, location: "Walk-in · freezer A", avgUse: 9, maxUse: 14, lead: 1, maxLead: 2, par: 50, pack: 10, vendor: "v-meat" },
  { sku: "MEAT-CHL-02", name: "Chicken leg quarters", category: "meat", unit: "kg", stock: 47.9, cost: 38000, location: "Walk-in · freezer A", avgUse: 7, maxUse: 11, lead: 1, maxLead: 2, par: 40, pack: 10, vendor: "v-meat" },
  { sku: "MEAT-MUT-03", name: "Mutton (bone-in)", category: "meat", unit: "kg", stock: 0, cost: 145000, location: "Walk-in · freezer B", avgUse: 3, maxUse: 6, lead: 2, maxLead: 3, par: 30, pack: 5, vendor: "v-meat" },
  { sku: "MEAT-BEEF04", name: "Ground beef", category: "meat", unit: "kg", stock: 14.4, cost: 92000, location: "Walk-in · freezer B", avgUse: 5, maxUse: 8, lead: 2, maxLead: 3, par: 35, pack: 5, vendor: "v-meat" },
  { sku: "DRY-MAIDA05", name: "Flour (maida)", category: "dry", unit: "kg", stock: 152.5, cost: 8500, location: "Dry store", avgUse: 11, maxUse: 16, lead: 3, maxLead: 5, par: 125, pack: 25, vendor: "v-dry" },
  { sku: "DRY-RICE-06", name: "Basmati rice", category: "dry", unit: "kg", stock: 191, cost: 16500, location: "Dry store", avgUse: 14, maxUse: 20, lead: 3, maxLead: 5, par: 150, pack: 25, vendor: "v-dry" },
  { sku: "DRY-DAL-07", name: "Lentils (masoor dal)", category: "dry", unit: "kg", stock: 63, cost: 14500, location: "Dry store", avgUse: 8, maxUse: 12, lead: 3, maxLead: 5, par: 100, pack: 20, vendor: "v-dry" },
  { sku: "DRY-SUGAR08", name: "Sugar", category: "dry", unit: "kg", stock: 85.5, cost: 11000, location: "Dry store", avgUse: 6, maxUse: 9, lead: 3, maxLead: 5, par: 75, pack: 25, vendor: "v-dry" },
  { sku: "DRY-SPICE09", name: "House masala mix", category: "dry", unit: "kg", stock: 16.8, cost: 62000, location: "Dry store", avgUse: 2.2, maxUse: 3.5, lead: 5, maxLead: 8, par: 42, pack: 2, vendor: "v-dry" },
  { sku: "PRO-POTAT10", name: "Potatoes", category: "produce", unit: "kg", stock: 105.6, cost: 4200, location: "Cool room", avgUse: 16, maxUse: 24, lead: 1, maxLead: 2, par: 90, pack: 30, vendor: "v-produce" },
  { sku: "PRO-ONION11", name: "Onions", category: "produce", unit: "kg", stock: 66, cost: 6800, location: "Cool room", avgUse: 10, maxUse: 15, lead: 1, maxLead: 2, par: 60, pack: 20, vendor: "v-produce" },
  { sku: "PRO-TOMAT12", name: "Tomatoes", category: "produce", unit: "kg", stock: 27.3, cost: 7500, location: "Cool room", avgUse: 9, maxUse: 13, lead: 1, maxLead: 2, par: 45, pack: 15, vendor: "v-produce" },
  { sku: "PRO-CABBA13", name: "Cabbage", category: "produce", unit: "kg", stock: 34.7, cost: 5200, location: "Cool room", avgUse: 5, maxUse: 8, lead: 1, maxLead: 2, par: 30, pack: 10, vendor: "v-produce" },
  { sku: "PRO-CAPSI14", name: "Capsicum", category: "produce", unit: "kg", stock: 26.4, cost: 12500, location: "Cool room", avgUse: 4, maxUse: 6, lead: 1, maxLead: 2, par: 24, pack: 8, vendor: "v-produce" },
  { sku: "PRO-LEMON15", name: "Lemons", category: "produce", unit: "kg", stock: 4.8, cost: 18000, location: "Cool room", avgUse: 2.5, maxUse: 4, lead: 1, maxLead: 2, par: 15, pack: 5, vendor: "v-produce" },
  { sku: "PRO-GARLI16", name: "Ginger & garlic paste", category: "produce", unit: "kg", stock: 30, cost: 22000, location: "Cool room", avgUse: 3, maxUse: 5, lead: 2, maxLead: 3, par: 24, pack: 4, vendor: "v-produce" },
  { sku: "DAI-PANEE17", name: "Paneer", category: "dairy", unit: "kg", stock: 6, cost: 78000, location: "Walk-in · dairy", avgUse: 3.5, maxUse: 5, lead: 1, maxLead: 2, par: 15, pack: 5, vendor: "v-dairy" },
  { sku: "DAI-MOZZA18", name: "Mozzarella", category: "dairy", unit: "kg", stock: 53.6, cost: 115000, location: "Walk-in · dairy", avgUse: 4, maxUse: 7, lead: 2, maxLead: 4, par: 45, pack: 5, vendor: "v-dairy" },
  { sku: "DAI-BUTTE19", name: "Butter", category: "dairy", unit: "kg", stock: 38.5, cost: 125000, location: "Walk-in · dairy", avgUse: 3, maxUse: 5, lead: 2, maxLead: 4, par: 30, pack: 5, vendor: "v-dairy" },
  { sku: "DAI-MILK-20", name: "Full cream milk", category: "dairy", unit: "ltr", stock: 54.6, cost: 9500, location: "Walk-in · dairy", avgUse: 18, maxUse: 26, lead: 1, maxLead: 2, par: 80, pack: 20, vendor: "v-dairy" },
  { sku: "DAI-YOGHU21", name: "Yoghurt (dahi)", category: "dairy", unit: "kg", stock: 29.8, cost: 12000, location: "Walk-in · dairy", avgUse: 4, maxUse: 7, lead: 1, maxLead: 2, par: 25, pack: 5, vendor: "v-dairy" },
  { sku: "DAI-EGGS-22", name: "Eggs", category: "dairy", unit: "pcs", stock: 396, cost: 1600, location: "Walk-in · dairy", avgUse: 60, maxUse: 90, lead: 1, maxLead: 2, par: 360, pack: 180, vendor: "v-produce" },
  { sku: "OIL-COOK-23", name: "Cooking oil", category: "dry", unit: "ltr", stock: 171, cost: 21000, location: "Dry store", avgUse: 12, maxUse: 18, lead: 3, maxLead: 5, par: 140, pack: 20, vendor: "v-dry" },
  { sku: "BAK-BUN-24", name: "Brioche burger buns", category: "bakery", unit: "pcs", stock: 54, cost: 3500, location: "Bakery rack", avgUse: 30, maxUse: 45, lead: 1, maxLead: 2, par: 144, pack: 24, vendor: "v-produce" },
  { sku: "BAK-PBASE25", name: "Pizza bases 10in", category: "bakery", unit: "pcs", stock: 206.4, cost: 6500, location: "Bakery rack", avgUse: 22, maxUse: 34, lead: 2, maxLead: 3, par: 168, pack: 24, vendor: "v-dry" },
  { sku: "BEV-BEER-26", name: "Nepal lager 330ml", category: "beverage", unit: "btl", stock: 462, cost: 28000, location: "Bar · cooler", avgUse: 36, maxUse: 60, lead: 2, maxLead: 4, par: 360, pack: 24, vendor: "v-bev" },
  { sku: "BEV-WHISK27", name: "Blended whisky", category: "beverage", unit: "ltr", stock: 15.8, cost: 380000, location: "Bar · lockup", avgUse: 1.4, maxUse: 2.5, lead: 3, maxLead: 6, par: 24, pack: 6, vendor: "v-bev" },
  { sku: "BEV-COLA-28", name: "Cola 330ml", category: "beverage", unit: "can", stock: 391.5, cost: 6000, location: "Bar · cooler", avgUse: 40, maxUse: 65, lead: 2, maxLead: 3, par: 288, pack: 24, vendor: "v-bev" },
  { sku: "BEV-TEA-29", name: "Tea leaves", category: "beverage", unit: "kg", stock: 20, cost: 85000, location: "Bar · dry", avgUse: 1.1, maxUse: 1.8, lead: 4, maxLead: 6, par: 16, pack: 2, vendor: "v-dry" },
  { sku: "DIS-NAPKI30", name: "Napkins", category: "disposable", unit: "pcs", stock: 13140, cost: 120, location: "FOH store", avgUse: 600, maxUse: 900, lead: 5, maxLead: 8, par: 11000, pack: 1000, vendor: "v-dry" },
  { sku: "DES-CHOCO31", name: "Dark chocolate", category: "dessert", unit: "kg", stock: 25.6, cost: 210000, location: "Pastry fridge", avgUse: 1.2, maxUse: 2, lead: 4, maxLead: 7, par: 22, pack: 2, vendor: "v-dairy" },
  { sku: "DES-ICECR32", name: "Vanilla ice cream", category: "dessert", unit: "ltr", stock: 38.5, cost: 62000, location: "Freezer C", avgUse: 3, maxUse: 5, lead: 2, maxLead: 4, par: 30, pack: 5, vendor: "v-dairy" },
];

const VENDORS = [
  { id: "v-produce", name: "Birgunj Fresh Produce", contact: "Suresh Agrawal", email: "orders@birgunjfresh.np", phone: "+977 985 501 2200", address: "Ward 9, Adarsh Nagar, Birgunj", terms: "net_7", minOrder: 5000, lead: 1, edi: 0, cutoff: "20:00", preferred: 1 },
  { id: "v-meat", name: "Nepal Cold Storage & Meats", contact: "Imran Qureshi", email: "sales@nepalcoldstorage.np", phone: "+977 984 602 7788", address: "Industrial Estate, Pathlaiya", terms: "net_15", minOrder: 25000, lead: 2, edi: 1, cutoff: "17:00", preferred: 1 },
  { id: "v-dairy", name: "Himalayan Dairy Supplies", contact: "Gita Bhandari", email: "supply@himalayandairy.np", phone: "+977 981 445 9090", address: "Ring Road, Kathmandu", terms: "net_15", minOrder: 15000, lead: 2, edi: 0, cutoff: "16:00", preferred: 0 },
  { id: "v-dry", name: "Terai Dry Goods & Spices", contact: "Ramesh Keshri", email: "orders@teraidrygoods.np", phone: "+977 980 331 4455", address: "Bhawanipur, Bara", terms: "net_30", minOrder: 20000, lead: 4, edi: 1, cutoff: "18:00", preferred: 0 },
  { id: "v-bev", name: "Madhesh Beverage Distributors", contact: "Anoj Mahato", email: "trade@madheshbev.np", phone: "+977 986 778 1212", address: "Birgunj Trade Centre", terms: "net_15", minOrder: 40000, lead: 3, edi: 1, cutoff: "15:00", preferred: 1 },
];

// ------------------------------------------------------------------- prep data
const PREP_SHEETS: Record<string, { allergens: string; plating: string; steps: { text: string; seconds?: number }[] }> = {
  "Chicken Momo (Steamed)": {
    allergens: "Gluten, sesame",
    plating: "Ten pieces in a bamboo basket, achar in a separate 60ml bowl, lemon wedge at 4 o'clock.",
    steps: [
      { text: "Check the steamer water level and bring to a full rolling boil." },
      { text: "Load baskets with a 1cm gap — never stack momo directly on top of each other." },
      { text: "Steam at full pressure.", seconds: 720 },
      { text: "Lid away from you; check one momo is translucent and the filling reads 74°C." },
      { text: "Plate into the basket, garnish with coriander and a sesame seed sprinkle." },
    ],
  },
  "House Burger": {
    allergens: "Gluten, egg, sesame",
    plating: "Burger centred on the board, skewer at 45°, side in the ramekin at 3 o'clock, sauce dotted at 9.",
    steps: [
      { text: "Confirm the cook temperature modifier before the patty hits the grill." },
      { text: "Press the 150g patty, season the top face only, lay it on a 220°C plancha." },
      { text: "Sear undisturbed.", seconds: 180 },
      { text: "Flip, season the second face, add cheese now if the modifier says so." },
      { text: "Finish to temperature — well done 74°C, medium well 71°C, medium 68°C, rare 63°C.", seconds: 150 },
      { text: "Toast the brioche cut-side down for 20 seconds, build base-up: sauce, lettuce, patty, onion, tomato, crown." },
      { text: "Rest before boxing so the bun does not go soggy.", seconds: 60 },
    ],
  },
  "Thakali Khana Set (Veg)": {
    allergens: "Dairy",
    plating: "Rice at 6 o'clock, dal at 12, tarkari at 3, achar at 9, dahi in the katori, papad upright.",
    steps: [
      { text: "Warm the thali plate — a cold plate kills the dal." },
      { text: "Rice: one 250g scoop, moulded lightly, no compacting." },
      { text: "Dal: 200ml ladle, poured at the table edge to avoid drips." },
      { text: "Tarkari: seasonal vegetable, 150g, drained of excess oil." },
      { text: "Achar: 30ml tomato-timur; dahi katori 60g." },
      { text: "Final check against the allergen sheet — dahi is the only allergen on the veg set." },
    ],
  },
  "Chicken Chowmein": {
    allergens: "Gluten, soy, egg",
    plating: "Twisted nest in the centre, garnish spring onion and a lemon cheek on the rim.",
    steps: [
      { text: "Blanch noodles 90 seconds, drain and toss with oil so they do not clump.", seconds: 90 },
      { text: "Wok to full heat; scramble the egg first, then set aside." },
      { text: "Stir-fry chicken until opaque, add onion and capsicum." },
      { text: "Return noodles and egg, add soy and house sauce along the wok edge, not onto the noodles." },
      { text: "Toss for 60 seconds — the wok should smell toasted, not wet.", seconds: 60 },
    ],
  },
  "Tandoori Chicken (Half)": {
    allergens: "Dairy",
    plating: "Half bird on the sizzler, charred lemon and onion rings, mint chutney in the dip well.",
    steps: [
      { text: "Pull from the marinade — 12 hours minimum, never less." },
      { text: "Skewer through the thigh so the bird hangs evenly." },
      { text: "Tandoor at 300°C, 8 minutes first side.", seconds: 480 },
      { text: "Turn, baste with butter, 6 minutes more.", seconds: 360 },
      { text: "Probe the thigh: 74°C minimum. Rest 3 minutes before plating.", seconds: 180 },
    ],
  },
};

export function seedIfEmpty(): { seeded: boolean } {
  migrate();
  const existing = get<{ value: string }>("SELECT value FROM settings WHERE key = 'seed_version'");
  if (existing) return { seeded: false };
  seedAll();
  return { seeded: true };
}

export function seedAll(): void {
  const rnd = random(20261104);
  tx(() => {
    seedSettings();
    seedTerminals();
    seedStations();
    const roles = seedRoles();
    const staff = seedStaff(roles);
    const sections = seedSections();
    const tables = seedTables(sections);
    const categories = seedCategories();
    const menu = seedMenu(categories);
    seedPrepSheets(menu);
    const vendors = seedVendors();
    const inventory = seedInventory(vendors);
    seedRecipes(menu, inventory);
    seedQrTokens(tables);
    seedBusinessDay();
    seedLiveService(tables, menu, staff, rnd);
    seedHosting(tables, rnd);
    seedScheduling(staff, rnd);
    seedInventoryOps(inventory, staff, rnd);
    seedPurchasing(vendors, inventory, rnd);
  });
  seedHistory(rnd);
}

function seedSettings(): void {
  for (const [key, value] of Object.entries(SETTINGS)) {
    run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)", key, value, nowStamp());
  }
}

function nowStamp(): string {
  return zoned().stamp;
}

function seedTerminals(): void {
  const terminals = [
    { id: "term-pos-1", name: "Register 1", area: "Main bar", kind: "pos" },
    { id: "term-pos-2", name: "Register 2", area: "Terrace", kind: "pos" },
    { id: "term-kds-1", name: "Kitchen KDS", area: "Hot line", kind: "kds" },
    { id: "term-host-1", name: "Host stand", area: "Entrance", kind: "host" },
    { id: "term-cfd-1", name: "Customer display", area: "Register 1", kind: "cfd" },
  ];
  for (const terminal of terminals) {
    run("INSERT INTO terminals (id, name, area, kind, is_active) VALUES (?, ?, ?, ?, 1)", terminal.id, terminal.name, terminal.area, terminal.kind);
  }
}

function seedStations(): void {
  seedCoreStations();
}

function seedRoles(): Map<string, string> {
  return seedCoreRoles();
}

function seedStaff(roles: Map<string, string>): Map<string, { id: string; name: string; role: string }> {
  const staff = new Map<string, { id: string; name: string; role: string }>();
  for (const member of STAFF) {
    const id = uuid();
    run(
      `INSERT INTO employees (id, name, role_id, pin, initials, color, phone, is_active, hire_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id,
      member.name,
      roles.get(member.role) ?? null,
      member.pin,
      initials(member.name),
      member.color,
      member.phone,
      shiftDate(today(), -180),
      nowStamp(),
    );
    staff.set(member.name, { id, name: member.name, role: member.role });
  }
  return staff;
}

function seedSections(): Map<string, string> {
  const ids = new Map<string, string>();
  SECTIONS.forEach((section, index) => {
    const id = uuid();
    ids.set(section.id, id);
    run("INSERT INTO sections (id, name, color, sort_order) VALUES (?, ?, ?, ?)", id, section.name, section.color, index);
  });
  return ids;
}

function seedTables(sections: Map<string, string>): { id: string; label: string }[] {
  const created: { id: string; label: string }[] = [];
  TABLES.forEach((table, index) => {
    const id = uuid();
    run(
      `INSERT INTO tables (id, label, section_id, capacity, shape, x, y, w, h, rotation, status, guests, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'available', 0, ?)`,
      id,
      table.label,
      sections.get(table.section) ?? null,
      table.capacity,
      table.shape,
      table.x,
      table.y,
      table.w,
      table.h,
      index,
    );
    created.push({ id, label: table.label });
  });
  return created;
}

function seedCategories(): Map<string, string> {
  const ids = new Map<string, string>();
  CATEGORIES.forEach((category, index) => {
    const id = uuid();
    ids.set(category.id, id);
    run(
      "INSERT INTO categories (id, name, icon, color, sort_order, is_active) VALUES (?, ?, ?, ?, ?, 1)",
      id,
      category.name,
      category.icon,
      category.color,
      index,
    );
  });
  return ids;
}

function seedMenu(categories: Map<string, string>): Map<string, { id: string; name: string; price: number }> {
  const items = new Map<string, { id: string; name: string; price: number }>();
  MENU.forEach((seed, index) => {
    const id = uuid();
    const price = Math.round(seed.price * 100);
    run(
      `INSERT INTO menu_items
        (id, category_id, name, description, price, cost, course, station, allergens, prep_minutes,
         emoji, is_available, is_featured, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id,
      categories.get(seed.category) ?? null,
      seed.name,
      seed.description,
      price,
      seed.course,
      seed.station,
      seed.allergens ?? "",
      seed.prep ?? 10,
      seed.emoji,
      seed.featured ? 1 : 0,
      index,
      nowStamp(),
      nowStamp(),
    );
    for (const group of seed.groups ?? []) {
      const groupId = uuid();
      run(
        `INSERT INTO modifier_groups (id, menu_item_id, name, min_select, max_select, is_required, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        groupId,
        id,
        group.name,
        group.min,
        group.max,
        group.required ? 1 : 0,
        (seed.groups ?? []).indexOf(group),
      );
      group.options.forEach((option, optionIndex) => {
        run(
          `INSERT INTO modifiers (id, group_id, menu_item_id, name, price, is_default, is_available, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          uuid(),
          groupId,
          id,
          option.name,
          Math.round(option.price * 100),
          option.isDefault ? 1 : 0,
          optionIndex,
        );
      });
    }
    items.set(seed.name, { id, name: seed.name, price });
  });
  // 86 one item so the "out of stock" state is visible in the POS and the menu
  // manager. Mutton (bone-in) is at zero stock, which is why the curry is off.
  const soldOut = items.get("Mutton Curry");
  if (soldOut) run("UPDATE menu_items SET is_available = 0 WHERE id = ?", soldOut.id);
  return items;
}

function seedPrepSheets(menu: Map<string, { id: string }>): void {
  for (const [name, sheet] of Object.entries(PREP_SHEETS)) {
    const item = menu.get(name);
    if (!item) continue;
    const station = get<{ station: string }>("SELECT station FROM menu_items WHERE id = ?", item.id)?.station ?? "grill";
    run(
      `INSERT INTO prep_sheets (id, menu_item_id, station, allergens, plating, steps, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      uuid(),
      item.id,
      station,
      sheet.allergens,
      sheet.plating,
      JSON.stringify(sheet.steps),
      nowStamp(),
    );
  }
}

function seedVendors(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const vendor of VENDORS) {
    const id = uuid();
    ids.set(vendor.id, id);
    run(
      `INSERT INTO vendors (id, name, contact_name, email, phone, address, account_number,
        payment_terms, min_order, lead_time_days, edi_enabled, cutoff_time, preferred, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      id,
      vendor.name,
      vendor.contact,
      vendor.email,
      vendor.phone,
      vendor.address,
      `ACC-${vendor.id.slice(2).toUpperCase()}`,
      vendor.terms,
      Math.round(vendor.minOrder * 100),
      vendor.lead,
      vendor.edi,
      vendor.cutoff,
      vendor.preferred,
    );
  }
  return ids;
}

function seedInventory(vendors: Map<string, string>): Map<string, { id: string; name: string; unit: string }> {
  const items = new Map<string, { id: string; name: string; unit: string }>();
  for (const seed of INVENTORY) {
    const id = uuid();
    run(
      `INSERT INTO inventory_items
        (id, sku, name, category, unit, current_stock, unit_cost, storage_location,
         avg_daily_usage, max_daily_usage, lead_time_days, max_lead_time_days,
         par_level, pack_size, low_stock_threshold, vendor_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      id,
      seed.sku,
      seed.name,
      seed.category,
      seed.unit,
      seed.stock,
      Math.round(seed.cost),
      seed.location,
      seed.avgUse,
      seed.maxUse,
      seed.lead,
      seed.maxLead,
      seed.par,
      seed.pack,
      0,
      vendors.get(seed.vendor) ?? null,
    );
    items.set(seed.name, { id, name: seed.name, unit: seed.unit });
  }
  return items;
}

/**
 * Bill of materials. Quantities are per single portion in the ingredient's base
 * unit; costs drive recipe costing, P-Mix contribution and food-cost %.
 */
const RECIPES: Record<string, [string, number][]> = {
  "Chicken Momo (Steamed)": [["Flour (maida)", 0.12], ["Chicken breast", 0.16], ["Onions", 0.05], ["Tomatoes", 0.04], ["House masala mix", 0.006]],
  "Fried Momo": [["Flour (maida)", 0.12], ["Chicken breast", 0.16], ["Cooking oil", 0.05], ["Onions", 0.05]],
  "Chilli Chicken": [["Chicken breast", 0.22], ["Capsicum", 0.08], ["Onions", 0.07], ["Cooking oil", 0.04], ["House masala mix", 0.01]],
  "Vegetable Spring Roll": [["Flour (maida)", 0.1], ["Cabbage", 0.12], ["Cooking oil", 0.05]],
  "Paneer Pakoda": [["Paneer", 0.15], ["Flour (maida)", 0.06], ["Cooking oil", 0.06]],
  "Chicken Wings": [["Chicken leg quarters", 0.3], ["Cooking oil", 0.05], ["Sugar", 0.01]],
  "Tandoori Chicken (Half)": [["Chicken leg quarters", 0.6], ["Yoghurt (dahi)", 0.08], ["Butter", 0.02], ["House masala mix", 0.015]],
  "Chicken Tikka": [["Chicken breast", 0.25], ["Yoghurt (dahi)", 0.06], ["House masala mix", 0.012]],
  "Paneer Tikka": [["Paneer", 0.2], ["Capsicum", 0.08], ["Yoghurt (dahi)", 0.05]],
  "Tandoori Roti": [["Flour (maida)", 0.06]],
  "Butter Naan": [["Flour (maida)", 0.09], ["Butter", 0.015], ["Yoghurt (dahi)", 0.02]],
  "Thakali Khana Set (Veg)": [["Basmati rice", 0.25], ["Lentils (masoor dal)", 0.09], ["Potatoes", 0.12], ["Tomatoes", 0.06], ["Yoghurt (dahi)", 0.06], ["Cooking oil", 0.03]],
  "Thakali Set (Chicken)": [["Basmati rice", 0.25], ["Lentils (masoor dal)", 0.09], ["Chicken breast", 0.18], ["Tomatoes", 0.06], ["Yoghurt (dahi)", 0.06], ["Cooking oil", 0.03]],
  "Butter Chicken": [["Chicken breast", 0.26], ["Tomatoes", 0.12], ["Butter", 0.035], ["Full cream milk", 0.05], ["House masala mix", 0.014]],
  "Dal Bhat Tarkari": [["Basmati rice", 0.28], ["Lentils (masoor dal)", 0.1], ["Potatoes", 0.1], ["Cooking oil", 0.03]],
  "Mutton Curry": [["Mutton (bone-in)", 0.3], ["Onions", 0.1], ["Tomatoes", 0.08], ["House masala mix", 0.016]],
  "Paneer Butter Masala": [["Paneer", 0.2], ["Tomatoes", 0.12], ["Butter", 0.03], ["Full cream milk", 0.04]],
  "Veg Chowmein": [["Flour (maida)", 0.15], ["Cabbage", 0.1], ["Capsicum", 0.05], ["Onions", 0.05], ["Cooking oil", 0.04]],
  "Chicken Chowmein": [["Flour (maida)", 0.15], ["Chicken breast", 0.1], ["Eggs", 1], ["Cabbage", 0.08], ["Cooking oil", 0.04]],
  "Egg Fried Rice": [["Basmati rice", 0.25], ["Eggs", 2], ["Cooking oil", 0.03]],
  "Chicken Biryani": [["Basmati rice", 0.3], ["Chicken leg quarters", 0.25], ["Yoghurt (dahi)", 0.05], ["House masala mix", 0.015]],
  "Mixed Schezwan Noodles": [["Flour (maida)", 0.15], ["Chicken breast", 0.09], ["Capsicum", 0.06], ["Cooking oil", 0.04]],
  "Margherita Pizza": [["Pizza bases 10in", 1], ["Mozzarella", 0.14], ["Tomatoes", 0.1], ["Butter", 0.01]],
  "Chicken Tikka Pizza": [["Pizza bases 10in", 1], ["Mozzarella", 0.14], ["Chicken breast", 0.12], ["Tomatoes", 0.08], ["Onions", 0.04]],
  "House Burger": [["Brioche burger buns", 1], ["Ground beef", 0.15], ["Eggs", 1], ["Onions", 0.03], ["Tomatoes", 0.04], ["Potatoes", 0.18], ["Cooking oil", 0.03]],
  "Chicken Burger": [["Brioche burger buns", 1], ["Chicken leg quarters", 0.18], ["Flour (maida)", 0.04], ["Cabbage", 0.04], ["Cooking oil", 0.05]],
  "Crispy Fries": [["Potatoes", 0.28], ["Cooking oil", 0.05]],
  "Cheesy Garlic Bread": [["Flour (maida)", 0.12], ["Mozzarella", 0.08], ["Butter", 0.025]],
  "Gulab Jamun (2 pcs)": [["Full cream milk", 0.08], ["Sugar", 0.06], ["Flour (maida)", 0.03]],
  "Vanilla Ice Cream": [["Vanilla ice cream", 0.16]],
  "Chocolate Brownie": [["Dark chocolate", 0.07], ["Butter", 0.04], ["Sugar", 0.05], ["Eggs", 1], ["Vanilla ice cream", 0.08]],
  Kheer: [["Basmati rice", 0.05], ["Full cream milk", 0.22], ["Sugar", 0.04]],
  "Masala Chiya": [["Tea leaves", 0.008], ["Full cream milk", 0.18], ["Sugar", 0.015]],
  "Fresh Lime Soda": [["Lemons", 0.06], ["Sugar", 0.02], ["Cola 330ml", 0]],
  "Mango Lassi": [["Yoghurt (dahi)", 0.18], ["Sugar", 0.03], ["Full cream milk", 0.05]],
  "Soft Drink": [["Cola 330ml", 1]],
  "Cold Coffee": [["Full cream milk", 0.22], ["Tea leaves", 0.01], ["Sugar", 0.025]],
  "Mineral Water 1L": [["Napkins", 0]],
  "Nepal Lager": [["Nepal lager 330ml", 1]],
  "Whisky 60ml": [["Blended whisky", 0.06]],
  "House Cocktail": [["Blended whisky", 0.05], ["Lemons", 0.03], ["Sugar", 0.02]],
  "Virgin Mocktail": [["Lemons", 0.05], ["Sugar", 0.03]],
};

function seedRecipes(menu: Map<string, { id: string }>, inventory: Map<string, { id: string }>): void {
  for (const [itemName, components] of Object.entries(RECIPES)) {
    const item = menu.get(itemName);
    if (!item) continue;
    for (const [ingredientName, quantity] of components) {
      const ingredient = inventory.get(ingredientName);
      if (!ingredient || quantity <= 0) continue;
      run(
        `INSERT OR IGNORE INTO recipes (menu_item_id, inventory_item_id, quantity_required, is_modifier, modifier_id)
         VALUES (?, ?, ?, 0, '')`,
        item.id,
        ingredient.id,
        quantity,
      );
    }
  }
  // Derive each menu item's theoretical portion cost from its BOM.
  const rows = all<{ id: string; cost: number }>(
    `SELECT mi.id AS id, COALESCE(SUM(r.quantity_required * ii.unit_cost), 0) AS cost
       FROM menu_items mi
       LEFT JOIN recipes r ON r.menu_item_id = mi.id
       LEFT JOIN inventory_items ii ON ii.id = r.inventory_item_id
      GROUP BY mi.id`,
  );
  for (const row of rows) {
    run("UPDATE menu_items SET cost = ? WHERE id = ?", Math.round(row.cost), row.id);
  }
}

function seedQrTokens(tables: { id: string; label: string }[]): void {
  tables.forEach((table, index) => {
    const token = `t${(index + 1).toString().padStart(2, "0")}-${table.label.toLowerCase()}`;
    run("INSERT INTO qr_tokens (token, table_id, is_active, scans, created_at) VALUES (?, ?, 1, ?, ?)", token, table.id, index * 7 + 3, nowStamp());
  });
}

function seedBusinessDay(): void {
  const date = businessDateNow();
  const exists = get<{ id: string }>("SELECT id FROM business_days WHERE business_date = ?", date);
  if (!exists) {
    run(
      `INSERT INTO business_days (id, business_date, opened_at, status, opening_float)
       VALUES (?, ?, ?, 'open', 1500000)`,
      uuid(),
      date,
      atClock(date, "07:00"),
    );
  }
}

export interface SeedContext {
  tables: { id: string; label: string }[];
  menu: Map<string, { id: string; name: string; price: number }>;
  staff: Map<string, { id: string; name: string; role: string }>;
}

export function seedContext(): SeedContext | null {
  const tables = all<{ id: string; label: string }>("SELECT id, label FROM tables ORDER BY sort_order").map((row) => ({ id: row.id, label: row.label }));
  const menuRows = all<{ id: string; name: string; price: number }>("SELECT id, name, price FROM menu_items");
  const menu = new Map(menuRows.map((row) => [row.name, row]));
  const staffRows = all<{ id: string; name: string; rname: string | null }>(
    "SELECT e.id, e.name, r.name AS rname FROM employees e LEFT JOIN roles r ON r.id = e.role_id",
  );
  const staff = new Map(staffRows.map((row) => [row.name, { id: row.id, name: row.name, role: row.rname ?? "server" }]));
  if (!tables.length || !menu.size || !staff.size) return null;
  return { tables, menu, staff };
}

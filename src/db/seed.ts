/**
 * Local-dev seed data: ~40 orders spanning every granular status, payment
 * state, and due-date bucket, with real multi-entry status history (each
 * order is walked step-by-step through updateStatus(), not jumped straight
 * to its final status) and a reconciling payment ledger. Designer/master
 * names are the prototype's own (index.html's designerName/masterName
 * <select> options), for continuity with the app this replaced.
 *
 * Deliberately calls the Infrastructure repositories directly, not the
 * Application services -- seeding is an administrative bypass of RBAC (the
 * same way migrations/the service-role key bypass RLS), not a real user
 * request, so there's no AuthContext to construct. Every write still goes
 * through the real transactions/triggers/mappers those repositories own
 * (the order-number trigger, the order+history atomic write, etc.), so the
 * data this produces is exactly as consistent as data created through the
 * app itself -- just without an HTTP round trip per row.
 *
 * Safe to re-run: staff accounts are looked up by email first, so a second
 * run reuses the same 11 accounts instead of duplicating them (Supabase
 * Auth would reject the duplicate email anyway). It never deletes anything.
 */
import { eq } from "drizzle-orm";
import { db } from "../common/database/drizzle-client";
import { profiles } from "../modules/users/infrastructure/profile.schema";
import { DrizzleUsersRepository } from "../modules/users/infrastructure/drizzle-users.repository";
import { DrizzleOrdersRepository } from "../modules/orders/infrastructure/drizzle-orders.repository";
import { DrizzlePaymentsRepository } from "../modules/payments/infrastructure/drizzle-payments.repository";
import { authProvider } from "../common/auth/supabase-auth-provider";
import { storageProvider } from "../common/storage/supabase-storage-provider";
import { generatePassword } from "../common/crypto/credentials";
import { GRANULAR_STATUSES, DESIGN_STAGE_STATUSES, type GranularStatus } from "../domain/order-status";
import { PRODUCT_CATEGORIES, PAYMENT_METHODS, type ProductCategory, type PaymentStatus } from "../domain/product-categories";
import type { Role } from "../domain/roles";

const usersRepository = new DrizzleUsersRepository(authProvider);
const ordersRepository = new DrizzleOrdersRepository();
const paymentsRepository = new DrizzlePaymentsRepository();

const PAYMENT_METHOD_VALUES = PAYMENT_METHODS.map((m) => m.value);

// A minimal valid 1x1 transparent PNG -- just needs to be real image bytes
// Supabase Storage will accept, not a meaningful picture.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const DESIGNERS = ["Sunita Devi", "Kavita Sharma", "Meena Rao", "Rekha Gupta", "Anita Patel"];
const MASTER_TAILORS = ["Ramesh Kumar", "Suresh Yadav", "Mohan Lal", "Raju Tiwari", "Harish Singh"];
const ACCOUNTANT = "Deepa Iyer";
const OWNER = { fullName: "Priya Nair", email: "owner@needleeye.test" };

const CUSTOMERS = [
  "Ananya Reddy", "Kiran Malhotra", "Divya Bhatt", "Rohan Kapoor", "Sneha Joshi",
  "Vikram Singh", "Pooja Agarwal", "Arjun Mehta", "Nisha Verma", "Karan Chopra",
  "Lakshmi Menon", "Aditya Rao", "Ritu Saxena", "Manish Tiwari", "Swati Desai",
  "Rahul Bansal", "Priyanka Nair", "Sanjay Gupta", "Neha Kulkarni", "Vivek Pillai",
  "Shalini Iyer", "Gaurav Khanna", "Meera Pillai", "Amit Trivedi", "Kavya Shetty",
  "Deepak Mishra", "Anjali Rao", "Nikhil Bhatia", "Sunita Reddy", "Rajesh Kumar",
  "Preeti Sharma", "Ashok Yadav", "Vandana Singh", "Manoj Pandey", "Radhika Menon",
  "Suresh Iyer", "Pallavi Joshi", "Harsh Vardhan", "Geeta Krishnan", "Naveen Reddy",
] as const;

const ORDER_DETAILS: Record<ProductCategory, string[]> = {
  designer_blouse: [
    "Embroidered silk blouse with mirror work on sleeves.",
    "Zardozi work blouse, boat neck, matching the client's own saree.",
    "Simple cotton blouse with piping detail, everyday wear.",
  ],
  saree: [
    "Kanjeevaram saree, needs fall and pico stitching only.",
    "Chiffon saree with custom blouse fabric attached, full stitching.",
    "Banarasi saree fall/pico plus a matching designer blouse.",
  ],
  bridal_lehenga: [
    "Bridal lehenga with heavy zari embroidery, needs alteration by fitting date.",
    "Custom bridal lehenga, hand embroidery, dupatta border work included.",
    "Reception lehenga, sequin work, matching blouse and dupatta.",
  ],
  custom_ethnic_wear: [
    "Anarkali suit, custom embroidery on yoke, full set with dupatta.",
    "Sharara set for sangeet function, mirror work detailing.",
    "Indo-western fusion gown, custom fitting, client's own fabric.",
  ],
  boutique_fashion: [
    "Party wear gown, custom fitting and minor alteration.",
    "Co-ord set, machine embroidery on kurta, matching palazzo.",
    "Cape-style ethnic jacket over a plain kurta base.",
  ],
};

function daysFromToday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]!;
}

function categoryAmountRange(category: ProductCategory): [number, number] {
  switch (category) {
    case "bridal_lehenga":
      return [8000, 25000];
    case "custom_ethnic_wear":
      return [4000, 12000];
    case "saree":
      return [3000, 8000];
    case "boutique_fashion":
      return [3000, 10000];
    case "designer_blouse":
      return [2000, 4500];
  }
}

async function findOrCreateStaff(email: string, fullName: string, role: Role): Promise<{ id: string; password: string | null }> {
  const [existing] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.email, email)).limit(1);
  if (existing) return { id: existing.id, password: null };

  const password = generatePassword(fullName);
  const id = await usersRepository.createUser(email, fullName, role, password);
  return { id, password };
}

/** Walks an order step-by-step from design_pending up to (and including) `targetStatus`, so status history reflects a real multi-step workflow instead of one jump. */
async function advanceStatus(orderId: string, targetStatus: GranularStatus, designerId: string, masterTailorId: string): Promise<void> {
  const targetIndex = GRANULAR_STATUSES.findIndex((s) => s.value === targetStatus);
  for (let i = 1; i <= targetIndex; i++) {
    const status = GRANULAR_STATUSES[i]!.value;
    const changedBy = DESIGN_STAGE_STATUSES.includes(status) ? designerId : masterTailorId;
    await ordersRepository.updateStatus(orderId, status, changedBy);
  }
}

async function addLedgerEntries(orderId: string, totalAmount: number, paymentStatus: PaymentStatus, recordedBy: string, bookingDate: string): Promise<void> {
  const fraction = paymentStatus === "advance_paid" ? 0.2 + Math.random() * 0.15 : paymentStatus === "partially_paid" ? 0.4 + Math.random() * 0.35 : 1;
  const amount = paymentStatus === "fully_paid" ? totalAmount : Math.round(totalAmount * fraction);

  await paymentsRepository.create({
    orderId,
    amount,
    method: pick(PAYMENT_METHOD_VALUES, Math.floor(Math.random() * PAYMENT_METHOD_VALUES.length)),
    paidAt: bookingDate,
    recordedBy,
    notes: null,
  });
}

async function uploadPlaceholderImages(orderId: string, count: number, uploadedBy: string): Promise<void> {
  for (let slot = 1; slot <= count; slot++) {
    const file = {
      buffer: PLACEHOLDER_PNG,
      mimetype: "image/png",
      originalname: `reference-${slot}.png`,
      size: PLACEHOLDER_PNG.length,
    } as Express.Multer.File;

    const storagePath = await storageProvider.upload(orderId, slot, file);
    await ordersRepository.upsertImage({
      orderId,
      slot,
      storagePath,
      originalFilename: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
      uploadedBy,
    });
  }
}

async function main() {
  console.log("Seeding Needle Eye local dev data...\n");
  const credentials: Array<{ role: string; name: string; email: string; password: string }> = [];

  const owner = await findOrCreateStaff(OWNER.email, OWNER.fullName, "owner_manager");
  if (owner.password) credentials.push({ role: "owner_manager", name: OWNER.fullName, email: OWNER.email, password: owner.password });
  else console.log(`Owner/Manager already exists (${OWNER.email}), reusing.`);

  const accountantEmail = "deepa.iyer@needleeye.test";
  const accountant = await findOrCreateStaff(accountantEmail, ACCOUNTANT, "accountant");
  if (accountant.password) credentials.push({ role: "accountant", name: ACCOUNTANT, email: accountantEmail, password: accountant.password });

  const designers: { id: string; name: string }[] = [];
  for (const name of DESIGNERS) {
    const email = `${name.toLowerCase().replace(/\s+/g, ".")}@needleeye.test`;
    const staff = await findOrCreateStaff(email, name, "designer");
    designers.push({ id: staff.id, name });
    if (staff.password) credentials.push({ role: "designer", name, email, password: staff.password });
  }

  const masters: { id: string; name: string }[] = [];
  for (const name of MASTER_TAILORS) {
    const email = `${name.toLowerCase().replace(/\s+/g, ".")}@needleeye.test`;
    const staff = await findOrCreateStaff(email, name, "master_tailor");
    masters.push({ id: staff.id, name });
    if (staff.password) credentials.push({ role: "master_tailor", name, email, password: staff.password });
  }

  console.log(`Staff ready: 1 owner_manager, 1 accountant, ${designers.length} designers, ${masters.length} master tailors.\n`);

  const ORDER_COUNT = 40;
  // 4 due-date buckets x 10 orders each: overdue, urgent (<3d), due soon (<=7d), on track.
  const dueDateForBucket = (bucket: number, i: number): string => {
    if (bucket === 0) return daysFromToday(-(1 + (i % 20)));
    if (bucket === 1) return daysFromToday(i % 3);
    if (bucket === 2) return daysFromToday(3 + (i % 5));
    return daysFromToday(8 + (i % 50));
  };

  let created = 0;
  let withImages = 0;

  for (let i = 0; i < ORDER_COUNT; i++) {
    const designer = pick(designers, i);
    const master = pick(masters, i + 2);
    const category = pick(PRODUCT_CATEGORIES, i).value;
    const targetStatus = pick(GRANULAR_STATUSES, i).value;
    const paymentStatus: PaymentStatus = pick(["advance_paid", "partially_paid", "fully_paid"] as const, i);
    const bucket = i % 4;
    const dueDate = dueDateForBucket(bucket, i);
    const bookingDate = daysFromToday(-(5 + (i % 25)));
    const [minAmount, maxAmount] = categoryAmountRange(category);
    const totalAmount = Math.round((minAmount + Math.random() * (maxAmount - minAmount)) / 50) * 50;

    const order = await ordersRepository.create({
      customerName: pick(CUSTOMERS, i),
      phone: `9${800000000 + i}`,
      billNumber: `BILL-2026-${String(i + 1).padStart(3, "0")}`,
      bookingDate,
      dueDate,
      designerId: designer.id,
      masterTailorId: master.id,
      productCategory: category,
      orderDetails: pick(ORDER_DETAILS[category], i),
      handWork: i % 3 === 0,
      machineWork: i % 4 === 0,
      purchaseRequired: i % 5 === 0,
      paymentStatus,
      totalAmount,
      productionStatus: "design_pending",
      designerInstructions: i % 6 === 0 ? "Confirm measurements with client before cutting." : null,
      specialNotes: i % 7 === 0 ? "Client requested extra fabric buffer for future alterations." : null,
      createdBy: designer.id,
      updatedBy: designer.id,
    });

    await advanceStatus(order.id, targetStatus, designer.id, master.id);
    await addLedgerEntries(order.id, totalAmount, paymentStatus, designer.id, bookingDate);

    if (i % 3 === 0) {
      await uploadPlaceholderImages(order.id, 1 + (i % 3), designer.id);
      withImages++;
    }

    created++;
    if (created % 10 === 0) console.log(`  ${created}/${ORDER_COUNT} orders seeded...`);
  }

  console.log(`\nSeeded ${created} orders (${withImages} with reference images) with full status history and a reconciling payment ledger.\n`);

  if (credentials.length > 0) {
    console.log("New accounts created this run -- credentials are shown once, note them down:\n");
    for (const c of credentials) {
      console.log(`  ${c.role.padEnd(15)} ${c.name.padEnd(20)} ${c.email.padEnd(35)} ${c.password}`);
    }
  } else {
    console.log("No new staff accounts this run (all emails already existed) -- reusing prior credentials.");
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

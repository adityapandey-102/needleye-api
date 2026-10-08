import { Router, type Request } from "express";
import multer from "multer";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { requireCapability } from "../../../common/middleware/capability.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { validateBody } from "../../../common/http/validate.middleware";
import { uuidParam } from "../../../common/http/uuid-param";
import { createOrderDtoSchema, type CreateOrderDto } from "./dto/create-order.dto";
import { updateOrderDtoSchema, type UpdateOrderDto } from "./dto/update-order.dto";
import { updateOrderStatusDtoSchema, type UpdateOrderStatusDto } from "./dto/update-order-status.dto";
import { changePriceDtoSchema, type ChangePriceDto } from "./dto/change-price.dto";
import { deliveryLoadQuerySchema } from "./dto/delivery-load.dto";
import { validateImageUpload } from "./orders.validation";
import { OrdersService } from "../application/orders.service";
import { DrizzleOrdersRepository } from "../infrastructure/drizzle-orders.repository";
import { storageProvider } from "../../../common/storage/supabase-storage-provider";
import { businessToday, monthStartMonthsBack } from "../../../common/time/business-date";
import { env } from "../../../config/env";

/** Composition root for the Orders module -- wires the concrete (Infrastructure) adapter into the Application service. */
const ordersService = new OrdersService(new DrizzleOrdersRepository(), storageProvider);

export const ordersRouter = Router();

/** YYYY-MM-DD that is a real calendar date (rejects 2026-02-31). */
function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

/** Pagination bounds for GET /orders -- keep the default list response bounded, cap how much one request can pull. */
const DEFAULT_ORDERS_LIMIT = 20;
const MAX_ORDERS_LIMIT = 100;

function parseOrdersPage(query: Request["query"]): { limit: number; offset: number } {
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_ORDERS_LIMIT) : DEFAULT_ORDERS_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

ordersRouter.use(requireAuth);
// An :id that isn't a UUID names no order -> 404 (not a database error).
ordersRouter.param("id", uuidParam(ERROR_CODES.ORDER_NOT_FOUND, "Order"));

ordersRouter.get(
  "/",
  requireCapability("orders:read"),
  asyncHandler(async (req, res) => {
    const { search, status, designerId, masterTailorId, bucket, createdFrom, dueOn } = req.query;
    // Optional lower bound on the creation day (the Kanban's 2-month window). A
    // malformed date is a 400, never silently ignored (that would show everything).
    if (createdFrom !== undefined && !(typeof createdFrom === "string" && isRealIsoDate(createdFrom))) {
      throw new BadRequestError("createdFrom must be a real date (YYYY-MM-DD)", ERROR_CODES.VALIDATION_ERROR);
    }
    // Optional exact due day (the delivery calendar's "orders on this day" list).
    if (dueOn !== undefined && !(typeof dueOn === "string" && isRealIsoDate(dueOn))) {
      throw new BadRequestError("dueOn must be a real date (YYYY-MM-DD)", ERROR_CODES.VALIDATION_ERROR);
    }
    const result = await ordersService.listOrders(
      { profile: req.profile!, authUserId: req.authUserId! },
      {
        search: typeof search === "string" ? search : undefined,
        status: typeof status === "string" ? status : undefined,
        designerId: typeof designerId === "string" ? designerId : undefined,
        masterTailorId: typeof masterTailorId === "string" ? masterTailorId : undefined,
        bucket: typeof bucket === "string" ? bucket : undefined,
        createdFrom: typeof createdFrom === "string" ? createdFrom : undefined,
        dueOn: typeof dueOn === "string" ? dueOn : undefined,
      },
      parseOrdersPage(req.query),
    );
    res.json(result);
  }),
);

// Registered before "/:id" -- Express would otherwise match "stats"/"revenue" as :id.
ordersRouter.get(
  "/stats",
  requireCapability("orders:read"),
  asyncHandler(async (req, res) => {
    const stats = await ordersService.getStats({ profile: req.profile!, authUserId: req.authUserId! });
    res.json(stats);
  }),
);

// Per-staff workload report -- Owner/Manager only. Registered before "/:id"
// so "staff-report" isn't matched as an order id. `staffId` is required; the
// weekly breakdown covers `month` (YYYY-MM), defaulting to the current month
// (the UI offers the last 6 months and fetches per selection).
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
ordersRouter.get(
  "/staff-report",
  requireCapability("reports:staff"),
  asyncHandler(async (req, res) => {
    const staffId = typeof req.query.staffId === "string" ? req.query.staffId : "";
    if (!staffId) throw new BadRequestError("staffId is required", ERROR_CODES.VALIDATION_ERROR);
    const monthRaw = req.query.month;
    const month = typeof monthRaw === "string" && ISO_MONTH.test(monthRaw) ? monthRaw : new Date().toISOString().slice(0, 7);
    const report = await ordersService.getStaffReport(staffId, month);
    res.json(report);
  }),
);

// Payment-ledger activity feed over an inclusive [from, to] window --
// Owner/Manager + Accountant only (reports:financial). Registered before
// "/:id" so "ledger-events" isn't matched as an order id. Defaults to the last
// 12 months; paginated (the revenue page's year/month/week filters map to a
// [from, to] here and page through the results).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
ordersRouter.get(
  "/ledger-events",
  requireCapability("reports:financial"),
  asyncHandler(async (req, res) => {
    // Defaults are the SHOP's dates (business timezone), not UTC's -- see common/time/business-date.ts.
    const today = businessToday(new Date(), env.BUSINESS_TIMEZONE);
    const toRaw = req.query.to;
    const fromRaw = req.query.from;
    const to = typeof toRaw === "string" && ISO_DATE.test(toRaw) ? toRaw : today;
    const defaultFrom = monthStartMonthsBack(today, 11);
    let from = typeof fromRaw === "string" && ISO_DATE.test(fromRaw) ? fromRaw : defaultFrom;
    if (from > to) from = defaultFrom <= to ? defaultFrom : to;
    const events = await ordersService.getLedgerEvents({ from, to }, parseOrdersPage(req.query));
    res.json(events);
  }),
);

// The Ledger Activity export (CSV / PDF): every event of ONE week or ONE month,
// unpaged. Both dates required and real; the service refuses > 31 days, so a
// yearly export is impossible even when called directly.
ordersRouter.get(
  "/ledger-events/export",
  requireCapability("reports:financial"),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    if (typeof from !== "string" || typeof to !== "string" || !isRealIsoDate(from) || !isRealIsoDate(to)) {
      throw new BadRequestError("from and to must be real dates (YYYY-MM-DD)", ERROR_CODES.LEDGER_EXPORT_RANGE_INVALID);
    }
    res.json(await ordersService.getLedgerExport({ from, to }));
  }),
);

// Delivery-day load for the order form's availability check + calendar.
// Registered before "/:id" so "delivery-load" isn't matched as an order id.
// Gated on orders:create -- exactly the roles that pick due dates (owner,
// designer, PM); shop-wide counts only, never order details.
ordersRouter.get(
  "/delivery-load",
  requireCapability("orders:create"),
  asyncHandler(async (req, res) => {
    // Strict: a malformed range is a 400 (ZodError -> error middleware), never
    // a silent fallback -- a garbled date quietly becoming "today" would show
    // the wrong day's load.
    const query = deliveryLoadQuerySchema.parse(req.query);
    res.json(await ordersService.getDeliveryLoad(query));
  }),
);

ordersRouter.get(
  "/:id",
  requireCapability("orders:read"),
  asyncHandler(async (req, res) => {
    const order = await ordersService.getOrder({ profile: req.profile!, authUserId: req.authUserId! }, req.params.id!);
    res.json({ order });
  }),
);

ordersRouter.post(
  "/",
  requireCapability("orders:create"),
  validateBody(createOrderDtoSchema),
  asyncHandler(async (req, res) => {
    const order = await ordersService.createOrder({ profile: req.profile!, authUserId: req.authUserId! }, req.body as CreateOrderDto);
    res.status(201).json({ order });
  }),
);

ordersRouter.patch(
  "/:id",
  validateBody(updateOrderDtoSchema),
  asyncHandler(async (req, res) => {
    // productionStatus is intentionally not editable here -- status changes
    // (Kanban drag / detail-page status change) go through a dedicated
    // endpoint (not yet built) that enforces design-stage vs
    // production-stage RBAC.
    const { productionStatus: _ignored, ...dto } = req.body as UpdateOrderDto & { productionStatus?: unknown };
    const order = await ordersService.updateOrder({ profile: req.profile!, authUserId: req.authUserId! }, req.params.id!, dto);
    res.json({ order });
  }),
);

ordersRouter.patch(
  "/:id/status",
  validateBody(updateOrderStatusDtoSchema),
  asyncHandler(async (req, res) => {
    const { status } = req.body as UpdateOrderStatusDto;
    const order = await ordersService.updateStatus({ profile: req.profile!, authUserId: req.authUserId! }, req.params.id!, status);
    res.json({ order });
  }),
);

// Pricing (ADR 0008): the only way a total changes. Gated per change kind in
// the domain (set / raise / discount), so only orders:read here.
ordersRouter.put(
  "/:id/price",
  requireCapability("orders:read"),
  validateBody(changePriceDtoSchema),
  asyncHandler(async (req, res) => {
    const result = await ordersService.changePrice(
      { profile: req.profile!, authUserId: req.authUserId! },
      req.params.id!,
      req.body as ChangePriceDto,
    );
    res.json(result);
  }),
);

ordersRouter.get(
  "/:id/price-history",
  requireCapability("orders:read"),
  asyncHandler(async (req, res) => {
    const history = await ordersService.getPriceHistory({ profile: req.profile!, authUserId: req.authUserId! }, req.params.id!);
    res.json({ history });
  }),
);

ordersRouter.get(
  "/:id/history",
  requireCapability("orders:read"),
  asyncHandler(async (req, res) => {
    const history = await ordersService.getOrderHistory({ profile: req.profile!, authUserId: req.authUserId! }, req.params.id!);
    res.json({ history });
  }),
);

ordersRouter.post(
  "/:id/images",
  requireCapability("orders:edit:customer_product_fields"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    // multipart/form-data, not JSON -- multer puts text fields on req.body as plain strings, no validateBody DTO for this one (see orders.validation.ts).
    const slot = Number((req.body as { slot?: string }).slot);
    validateImageUpload(slot, req.file);

    const result = await ordersService.uploadOrderImage(
      { profile: req.profile!, authUserId: req.authUserId!, capabilityScope: req.capabilityScope },
      req.params.id!,
      slot,
      req.file,
    );
    res.status(201).json(result);
  }),
);

ordersRouter.delete(
  "/:id/images/:slot",
  requireCapability("orders:edit:customer_product_fields"),
  asyncHandler(async (req, res) => {
    await ordersService.deleteOrderImage(
      { profile: req.profile!, authUserId: req.authUserId!, capabilityScope: req.capabilityScope },
      req.params.id!,
      Number(req.params.slot),
    );
    res.status(204).send();
  }),
);

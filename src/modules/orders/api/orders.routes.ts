import { Router, type Request } from "express";
import multer from "multer";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { requireCapability } from "../../../common/middleware/capability.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { validateBody } from "../../../common/http/validate.middleware";
import { createOrderDtoSchema, type CreateOrderDto } from "./dto/create-order.dto";
import { updateOrderDtoSchema, type UpdateOrderDto } from "./dto/update-order.dto";
import { updateOrderStatusDtoSchema, type UpdateOrderStatusDto } from "./dto/update-order-status.dto";
import { validateImageUpload } from "./orders.validation";
import { OrdersService } from "../application/orders.service";
import { DrizzleOrdersRepository } from "../infrastructure/drizzle-orders.repository";
import { storageProvider } from "../../../common/storage/supabase-storage-provider";

/** Composition root for the Orders module -- wires the concrete (Infrastructure) adapter into the Application service. */
const ordersService = new OrdersService(new DrizzleOrdersRepository(), storageProvider);

export const ordersRouter = Router();
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

ordersRouter.get(
  "/",
  requireCapability("orders:read"),
  asyncHandler(async (req, res) => {
    const { search, status, designerId, masterTailorId, bucket } = req.query;
    const result = await ordersService.listOrders(
      { profile: req.profile!, authUserId: req.authUserId! },
      {
        search: typeof search === "string" ? search : undefined,
        status: typeof status === "string" ? status : undefined,
        designerId: typeof designerId === "string" ? designerId : undefined,
        masterTailorId: typeof masterTailorId === "string" ? masterTailorId : undefined,
        bucket: typeof bucket === "string" ? bucket : undefined,
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

// Financial revenue report over an inclusive [from, to] date window --
// Owner/Manager + Accountant only. Defaults to the last 12 months when the
// range is missing/invalid; the accountant can pick any year span from the UI.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
ordersRouter.get(
  "/revenue",
  requireCapability("reports:financial"),
  asyncHandler(async (req, res) => {
    const today = new Date();
    const toRaw = req.query.to;
    const fromRaw = req.query.from;
    const to = typeof toRaw === "string" && ISO_DATE.test(toRaw) ? toRaw : today.toISOString().slice(0, 10);
    const defaultFrom = new Date(today.getFullYear(), today.getMonth() - 11, 1).toISOString().slice(0, 10);
    let from = typeof fromRaw === "string" && ISO_DATE.test(fromRaw) ? fromRaw : defaultFrom;
    // Guard against an inverted range (from after to).
    if (from > to) from = defaultFrom <= to ? defaultFrom : to;
    const revenue = await ordersService.getRevenue({ profile: req.profile!, authUserId: req.authUserId! }, { from, to });
    res.json(revenue);
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
ordersRouter.get(
  "/ledger-events",
  requireCapability("reports:financial"),
  asyncHandler(async (req, res) => {
    const today = new Date();
    const toRaw = req.query.to;
    const fromRaw = req.query.from;
    const to = typeof toRaw === "string" && ISO_DATE.test(toRaw) ? toRaw : today.toISOString().slice(0, 10);
    const defaultFrom = new Date(today.getFullYear(), today.getMonth() - 11, 1).toISOString().slice(0, 10);
    let from = typeof fromRaw === "string" && ISO_DATE.test(fromRaw) ? fromRaw : defaultFrom;
    if (from > to) from = defaultFrom <= to ? defaultFrom : to;
    const events = await ordersService.getLedgerEvents({ from, to }, parseOrdersPage(req.query));
    res.json(events);
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

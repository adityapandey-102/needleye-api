import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { requireCapability } from "../../../common/middleware/capability.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { validateBody } from "../../../common/http/validate.middleware";
import { createOrderDtoSchema } from "./dto/create-order.dto";
import { updateOrderDtoSchema, type UpdateOrderDto } from "./dto/update-order.dto";
import { updateOrderStatusDtoSchema } from "./dto/update-order-status.dto";
import { validateImageUpload } from "./orders.validation";
import { OrdersService } from "../application/orders.service";
import { DrizzleOrdersRepository } from "../infrastructure/drizzle-orders.repository";
import { storageProvider } from "../../../common/storage/supabase-storage-provider";

/** Composition root for the Orders module -- wires the concrete (Infrastructure) adapter into the Application service. */
const ordersService = new OrdersService(new DrizzleOrdersRepository(), storageProvider);

export const ordersRouter = Router();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

ordersRouter.use(requireAuth);

ordersRouter.get(
  "/",
  requireCapability("orders:read"),
  asyncHandler(async (req, res) => {
    const { search, status, designerId, masterTailorId } = req.query;
    const orders = await ordersService.listOrders(
      { profile: req.profile!, authUserId: req.authUserId! },
      {
        search: typeof search === "string" ? search : undefined,
        status: typeof status === "string" ? status : undefined,
        designerId: typeof designerId === "string" ? designerId : undefined,
        masterTailorId: typeof masterTailorId === "string" ? masterTailorId : undefined,
      },
    );
    res.json({ orders });
  }),
);

// Registered before "/:id" -- Express would otherwise match "stats" as :id.
ordersRouter.get(
  "/stats",
  requireCapability("orders:read"),
  asyncHandler(async (req, res) => {
    const stats = await ordersService.getStats({ profile: req.profile!, authUserId: req.authUserId! });
    res.json(stats);
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
    const order = await ordersService.createOrder({ profile: req.profile!, authUserId: req.authUserId! }, req.body);
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
    const order = await ordersService.updateStatus({ profile: req.profile!, authUserId: req.authUserId! }, req.params.id!, req.body.status);
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
    const slot = Number(req.body.slot);
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

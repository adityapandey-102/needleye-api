import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../../shared/middleware/auth";
import { requireCapability } from "../../shared/middleware/capability";
import { asyncHandler } from "../../shared/asyncHandler";
import { BadRequestError } from "../../shared/errors";
import * as ordersService from "./orders.service";

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
  asyncHandler(async (req, res) => {
    const order = await ordersService.createOrder({ profile: req.profile!, authUserId: req.authUserId! }, req.body);
    res.status(201).json({ order });
  }),
);

ordersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const order = await ordersService.updateOrder(
      { profile: req.profile!, authUserId: req.authUserId! },
      req.params.id!,
      req.body,
    );
    res.json({ order });
  }),
);

ordersRouter.post(
  "/:id/images",
  requireCapability("orders:edit:customer_product_fields"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const slot = Number(req.body.slot);
    if (!req.file) throw new BadRequestError("No file uploaded");

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

import { Router } from "express";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { requireCapability } from "../../../common/middleware/capability.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { validateBody } from "../../../common/http/validate.middleware";
import { createPaymentDtoSchema, type CreatePaymentDto } from "./dto/create-payment.dto";
import { updatePaymentDtoSchema, type UpdatePaymentDto } from "./dto/update-payment.dto";
import { PaymentsService } from "../application/payments.service";
import { DrizzlePaymentsRepository } from "../infrastructure/drizzle-payments.repository";

/** Composition root for the Payments module -- wires the concrete (Infrastructure) adapter into the Application service. */
const paymentsService = new PaymentsService(new DrizzlePaymentsRepository());

/**
 * mergeParams: true -- this router is mounted at /orders/:orderId/payments
 * in app.ts, and needs req.params.orderId from the parent path segment.
 */
export const paymentsRouter = Router({ mergeParams: true });

paymentsRouter.use(requireAuth);

paymentsRouter.get(
  "/",
  requireCapability("payments:read"),
  asyncHandler(async (req, res) => {
    const payments = await paymentsService.listPayments(
      { profile: req.profile!, authUserId: req.authUserId!, capabilityScope: req.capabilityScope },
      req.params.orderId!,
    );
    res.json({ payments });
  }),
);

paymentsRouter.post(
  "/",
  requireCapability("payments:manage"),
  validateBody(createPaymentDtoSchema),
  asyncHandler(async (req, res) => {
    const payment = await paymentsService.addPayment(
      { profile: req.profile!, authUserId: req.authUserId!, capabilityScope: req.capabilityScope },
      req.params.orderId!,
      req.body as CreatePaymentDto,
    );
    res.status(201).json({ payment });
  }),
);

paymentsRouter.patch(
  "/:paymentId",
  requireCapability("payments:manage"),
  validateBody(updatePaymentDtoSchema),
  asyncHandler(async (req, res) => {
    const payment = await paymentsService.updatePayment(
      { profile: req.profile!, authUserId: req.authUserId!, capabilityScope: req.capabilityScope },
      req.params.orderId!,
      req.params.paymentId!,
      req.body as UpdatePaymentDto,
    );
    res.json({ payment });
  }),
);

paymentsRouter.delete(
  "/:paymentId",
  requireCapability("payments:manage"),
  asyncHandler(async (req, res) => {
    await paymentsService.deletePayment(
      { profile: req.profile!, authUserId: req.authUserId!, capabilityScope: req.capabilityScope },
      req.params.orderId!,
      req.params.paymentId!,
    );
    res.status(204).send();
  }),
);

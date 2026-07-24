import { BadRequestError, NotFoundError } from "../../../common/errors/app-error";
import { assertFieldsEditable, assertOwnershipForScopedEdit } from "../domain/order-edit.rules";
import { assertOrderCanBeMarkedFullyPaid } from "../domain/order-ledger.rules";
import { assertCanTransitionStatus } from "../domain/order-status.rules";
import { toOrderResponseDto } from "../api/order.presenter";
import { toOrderStatusHistoryResponseDto } from "../api/order-status-history.presenter";
import { toOrderStatsResponseDto } from "../api/order-stats.presenter";
import type { GranularStatus, Profile } from "../../../domain";
import type { StorageProvider } from "../../../common/storage/storage-provider";
import type { OrdersRepositoryPort, OrderListFilters, NewOrderRecord, UpdateOrderRecord } from "./ports/orders-repository.port";
import type { CreateOrderDto } from "../api/dto/create-order.dto";
import type { UpdateOrderDto } from "../api/dto/update-order.dto";
import type { OrderResponseDto } from "../api/dto/order.response.dto";
import type { OrderStatusHistoryResponseDto } from "../api/dto/order-status-history.response.dto";
import type { OrderStatsResponseDto } from "../api/dto/order-stats.response.dto";

interface AuthContext {
  profile: Profile;
  authUserId: string;
}

/**
 * Business logic for the Orders module: RBAC field-level rules, ownership
 * checks, and orchestration across the repository port and storage
 * provider. No direct database or HTTP knowledge -- those are the
 * Infrastructure adapter's and the Controller's jobs respectively.
 */
export class OrdersService {
  constructor(
    private readonly ordersRepository: OrdersRepositoryPort,
    private readonly storageProvider: StorageProvider,
  ) {}

  async listOrders(ctx: AuthContext, filters: OrderListFilters): Promise<OrderResponseDto[]> {
    const entities = await this.ordersRepository.findMany({ role: ctx.profile.role, userId: ctx.authUserId }, filters);
    const sums = await this.ordersRepository.sumPaymentsForOrders(entities.map((e) => e.id));
    return Promise.all(
      entities.map((entity) => toOrderResponseDto(entity, sums[entity.id] ?? 0, ctx.profile.role, this.storageProvider)),
    );
  }

  async getOrder(ctx: AuthContext, orderId: string): Promise<OrderResponseDto> {
    const entity = await this.ordersRepository.findById({ role: ctx.profile.role, userId: ctx.authUserId }, orderId);
    if (!entity) throw new NotFoundError("Order not found");
    const amountPaid = await this.ordersRepository.sumPaymentsForOrder(orderId);
    return toOrderResponseDto(entity, amountPaid, ctx.profile.role, this.storageProvider);
  }

  async createOrder(ctx: AuthContext, dto: CreateOrderDto): Promise<OrderResponseDto> {
    const record: NewOrderRecord = {
      ...dto,
      bookingDate: dto.bookingDate ?? new Date().toISOString().slice(0, 10),
      designerInstructions: dto.designerInstructions || null,
      specialNotes: dto.specialNotes || null,
      createdBy: ctx.authUserId,
      updatedBy: ctx.authUserId,
    };
    const entity = await this.ordersRepository.create(record);
    // A brand-new order has no ledger entries yet, but fetch for real rather
    // than assume 0 -- keeps this call site identical to every other one.
    const amountPaid = await this.ordersRepository.sumPaymentsForOrder(entity.id);
    return toOrderResponseDto(entity, amountPaid, ctx.profile.role, this.storageProvider);
  }

  async updateOrder(ctx: AuthContext, orderId: string, dto: UpdateOrderDto): Promise<OrderResponseDto> {
    const submittedKeys = Object.keys(dto);
    if (submittedKeys.length === 0) throw new BadRequestError("No editable fields to update");

    const { needsOwnershipCheck } = assertFieldsEditable(ctx.profile.role, submittedKeys);
    const markingFullyPaid = dto.paymentStatus === "fully_paid";

    if (needsOwnershipCheck || markingFullyPaid) {
      const existing = await this.ordersRepository.findBasicById(orderId);
      if (!existing) throw new NotFoundError("Order not found");
      if (needsOwnershipCheck) assertOwnershipForScopedEdit(existing.designerId, ctx.authUserId);

      if (markingFullyPaid) {
        const finalTotalAmount = dto.totalAmount ?? existing.totalAmount;
        const sum = await this.ordersRepository.sumPaymentsForOrder(orderId);
        assertOrderCanBeMarkedFullyPaid(sum, finalTotalAmount);
      }
    }

    const record: UpdateOrderRecord = { ...dto, updatedBy: ctx.authUserId };
    const entity = await this.ordersRepository.update(orderId, record);
    const amountPaid = await this.ordersRepository.sumPaymentsForOrder(orderId);
    return toOrderResponseDto(entity, amountPaid, ctx.profile.role, this.storageProvider);
  }

  /**
   * PATCH /orders/:id/status -- deliberately not gated by requireCapability
   * (the applicable capability depends on the *target* status, which isn't
   * known until the body is parsed), so assertCanTransitionStatus owns the
   * whole authorization decision here, same as updateOrder's field-split
   * check does for orders:edit:*.
   */
  async updateStatus(ctx: AuthContext, orderId: string, status: GranularStatus): Promise<OrderResponseDto> {
    const existing = await this.ordersRepository.findBasicById(orderId);
    if (!existing) throw new NotFoundError("Order not found");

    assertCanTransitionStatus(ctx.profile.role, status, existing, ctx.authUserId);

    const entity = await this.ordersRepository.updateStatus(orderId, status, ctx.authUserId);
    const amountPaid = await this.ordersRepository.sumPaymentsForOrder(orderId);
    return toOrderResponseDto(entity, amountPaid, ctx.profile.role, this.storageProvider);
  }

  async getStats(ctx: AuthContext): Promise<OrderStatsResponseDto> {
    const stats = await this.ordersRepository.getStats({ role: ctx.profile.role, userId: ctx.authUserId });
    return toOrderStatsResponseDto(stats, ctx.profile.role);
  }

  async getOrderHistory(ctx: AuthContext, orderId: string): Promise<OrderStatusHistoryResponseDto[]> {
    const order = await this.ordersRepository.findById({ role: ctx.profile.role, userId: ctx.authUserId }, orderId);
    if (!order) throw new NotFoundError("Order not found");

    const history = await this.ordersRepository.listStatusHistory(orderId);
    return history.map(toOrderStatusHistoryResponseDto);
  }

  async uploadOrderImage(
    ctx: AuthContext & { capabilityScope?: boolean | "assigned" },
    orderId: string,
    slot: number,
    file: Express.Multer.File,
  ): Promise<{ storagePath: string; url: string }> {
    await this.assertOrderEditable(ctx, orderId);

    const storagePath = await this.storageProvider.upload(orderId, slot, file);

    await this.ordersRepository.upsertImage({
      orderId,
      slot,
      storagePath,
      originalFilename: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
      uploadedBy: ctx.authUserId,
    });

    return { storagePath, url: await this.storageProvider.getSignedUrl(storagePath) };
  }

  async deleteOrderImage(
    ctx: AuthContext & { capabilityScope?: boolean | "assigned" },
    orderId: string,
    slot: number,
  ): Promise<void> {
    await this.assertOrderEditable(ctx, orderId);

    const image = await this.ordersRepository.findImage(orderId, slot);
    if (image) {
      await this.storageProvider.delete(image.storagePath);
      await this.ordersRepository.deleteImage(orderId, slot);
    }
  }

  private async assertOrderEditable(ctx: AuthContext & { capabilityScope?: boolean | "assigned" }, orderId: string): Promise<void> {
    const order = await this.ordersRepository.findBasicById(orderId);
    if (!order) throw new NotFoundError("Order not found");
    if (ctx.capabilityScope === "assigned") assertOwnershipForScopedEdit(order.designerId, ctx.authUserId);
  }
}

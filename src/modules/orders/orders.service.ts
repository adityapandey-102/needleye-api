import { getCapabilityScope, type Profile } from "../../domain";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../common/errors/app-error";
import type { StorageProvider } from "../../common/storage/storage-provider";
import type { OrdersRepository, OrderListFilters } from "./orders.repository";
import type { OrdersMapper } from "./orders.mapper";
import type { CreateOrderDto } from "./dto/create-order.dto";
import type { UpdateOrderDto } from "./dto/update-order.dto";
import type { OrderDto } from "./dto/order.dto";

/** Pricing/assignment fields are gated by a separate capability from every other editable field -- see updateOrder(). */
const PRICING_FIELDS = new Set(["totalAmount", "designerId", "masterTailorId"]);

interface AuthContext {
  profile: Profile;
  authUserId: string;
}

/**
 * Business logic for the Orders module: RBAC field-level rules, ownership
 * checks, and orchestration across the repository/mapper/storage provider.
 * No direct database or HTTP knowledge -- those are the Repository's and
 * the Controller's jobs respectively.
 */
export class OrdersService {
  constructor(
    private readonly ordersRepository: OrdersRepository,
    private readonly mapper: OrdersMapper,
    private readonly storageProvider: StorageProvider,
  ) {}

  async listOrders(ctx: AuthContext, filters: OrderListFilters): Promise<OrderDto[]> {
    const rows = await this.ordersRepository.findMany({ role: ctx.profile.role, userId: ctx.authUserId }, filters);
    const entities = rows.map((row) => this.mapper.toEntity(row));
    return Promise.all(entities.map((entity) => this.mapper.toDto(entity)));
  }

  async getOrder(ctx: AuthContext, orderId: string): Promise<OrderDto> {
    const row = await this.ordersRepository.findById({ role: ctx.profile.role, userId: ctx.authUserId }, orderId);
    if (!row) throw new NotFoundError("Order not found");
    return this.mapper.toDto(this.mapper.toEntity(row));
  }

  async createOrder(ctx: AuthContext, dto: CreateOrderDto): Promise<OrderDto> {
    const record = this.mapper.toNewOrderRecord(dto, ctx.authUserId);
    const row = await this.ordersRepository.create(record);
    return this.mapper.toDto(this.mapper.toEntity(row));
  }

  async updateOrder(ctx: AuthContext, orderId: string, dto: UpdateOrderDto): Promise<OrderDto> {
    const submittedKeys = Object.keys(dto);
    if (submittedKeys.length === 0) throw new BadRequestError("No editable fields to update");

    const customerProductScope = getCapabilityScope(ctx.profile.role, "orders:edit:customer_product_fields");
    const pricingScope = getCapabilityScope(ctx.profile.role, "orders:edit:pricing_assignment");

    const touchesPricing = submittedKeys.some((k) => PRICING_FIELDS.has(k));
    const touchesCustomerProduct = submittedKeys.some((k) => !PRICING_FIELDS.has(k));

    if (touchesPricing && pricingScope === false) {
      throw new ForbiddenError("Your role cannot edit pricing or assignment fields");
    }
    if (touchesCustomerProduct && customerProductScope === false) {
      throw new ForbiddenError("Your role cannot edit order details");
    }

    // Both remaining capabilities are either true or "assigned" at this
    // point for the fields actually being touched -- if either is scoped,
    // verify the caller is the order's assigned designer before allowing
    // the write.
    const needsOwnershipCheck =
      (touchesPricing && pricingScope === "assigned") || (touchesCustomerProduct && customerProductScope === "assigned");

    if (needsOwnershipCheck) {
      const existing = await this.ordersRepository.findBasicById(orderId);
      if (!existing) throw new NotFoundError("Order not found");
      if (existing.designer_id !== ctx.authUserId) {
        throw new ForbiddenError("You can only edit orders assigned to you");
      }
    }

    const record = this.mapper.toUpdateRecord(dto, ctx.authUserId);
    const row = await this.ordersRepository.update(orderId, record);
    return this.mapper.toDto(this.mapper.toEntity(row));
  }

  private async assertOrderEditable(ctx: AuthContext & { capabilityScope?: boolean | "assigned" }, orderId: string) {
    const order = await this.ordersRepository.findBasicById(orderId);
    if (!order) throw new NotFoundError("Order not found");
    if (ctx.capabilityScope === "assigned" && order.designer_id !== ctx.authUserId) {
      throw new ForbiddenError("You can only edit orders assigned to you");
    }
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
      order_id: orderId,
      slot,
      storage_path: storagePath,
      original_filename: file.originalname,
      content_type: file.mimetype,
      size_bytes: file.size,
      uploaded_by: ctx.authUserId,
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
      await this.storageProvider.delete(image.storage_path);
      await this.ordersRepository.deleteImage(orderId, slot);
    }
  }
}

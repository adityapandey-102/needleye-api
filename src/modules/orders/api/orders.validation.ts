import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

/**
 * Image-upload validation, kept out of orders.service.ts on purpose:
 * multer's file object isn't representable as a zod/JSON-body DTO the way
 * validate.middleware.ts handles everything else, but "is this a
 * well-formed request" is still a validation concern, not a business rule
 * -- so it gets its own small, explicit function the controller calls
 * before invoking the service, rather than being folded into it.
 */
export function validateImageUpload(slot: number, file: Express.Multer.File | undefined): asserts file is Express.Multer.File {
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
    throw new BadRequestError("slot must be an integer between 1 and 4", ERROR_CODES.IMAGE_INVALID_SLOT);
  }
  if (!file) {
    throw new BadRequestError("No file uploaded", ERROR_CODES.IMAGE_MISSING);
  }
  if (!file.mimetype.startsWith("image/")) {
    throw new BadRequestError("Please upload an image file", ERROR_CODES.IMAGE_INVALID_TYPE);
  }
}

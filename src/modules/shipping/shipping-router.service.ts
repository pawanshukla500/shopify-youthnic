import prisma from '../../database/prisma';
import { config } from '../../config';
import delhiveryService from '../delhivery/delhivery.service';
import velocityService from '../velocity/velocity.service';
import logger from '../../utils/logger';
import { Order } from '@prisma/client';

export type CarrierPriority = 'DELHIVERY_FIRST' | 'VELOCITY_FIRST';
export type CourierChoice = 'Delhivery' | 'Velocity';

export const SHIPPING_PRIORITY_SETTING_KEY = 'shipping_carrier_priority';

export class ShippingRouterService {
  /**
   * Get current shipping carrier priority
   */
  async getCarrierPriority(): Promise<CarrierPriority> {
    try {
      const setting = await prisma.setting.findUnique({
        where: { key: SHIPPING_PRIORITY_SETTING_KEY },
      });
      if (setting?.value === 'VELOCITY_FIRST' || setting?.value === 'DELHIVERY_FIRST') {
        return setting.value as CarrierPriority;
      }
    } catch (err: any) {
      logger.warn('Failed to load carrier priority setting from database, using config fallback', {
        error: err.message,
      });
    }
    return config.shipping.defaultPriority || 'DELHIVERY_FIRST';
  }

  /**
   * Set shipping carrier priority
   */
  async setCarrierPriority(priority: CarrierPriority): Promise<void> {
    await prisma.setting.upsert({
      where: { key: SHIPPING_PRIORITY_SETTING_KEY },
      create: { key: SHIPPING_PRIORITY_SETTING_KEY, value: priority },
      update: { value: priority },
    });
    logger.info('Updated shipping carrier priority', { priority });
  }

  /**
   * Resolve best carrier for an order based on priority, configuration, and serviceability.
   */
  async resolveCarrierForOrder(
    order: Order,
    explicitChoice?: CourierChoice | 'auto'
  ): Promise<{ courier: CourierChoice; reason: string }> {
    // 1. Explicit choice takes precedence
    if (explicitChoice === 'Delhivery') {
      return { courier: 'Delhivery', reason: 'Explicit operator selection: Delhivery' };
    }
    if (explicitChoice === 'Velocity') {
      return { courier: 'Velocity', reason: 'Explicit operator selection: Velocity' };
    }

    const priority = await this.getCarrierPriority();
    const destinationPincode = order.customerPincode?.trim() || '';
    const paymentMode = order.paymentMethod === 'COD' ? 'cod' : 'prepaid';
    const originPincode = config.delhivery.seller.pincode || '395002';

    const hasDelhiveryToken = Boolean(config.delhivery.apiToken);
    const hasVelocityToken = Boolean(config.velocity.apiToken);

    // If only one carrier is configured with credentials, use that carrier
    if (hasDelhiveryToken && !hasVelocityToken) {
      return { courier: 'Delhivery', reason: 'Only Delhivery credentials are configured' };
    }
    if (!hasDelhiveryToken && hasVelocityToken) {
      return { courier: 'Velocity', reason: 'Only Velocity credentials are configured' };
    }

    // 2. Check routing by configured priority
    if (priority === 'VELOCITY_FIRST') {
      try {
        const velCheck = await velocityService.checkServiceability({
          fromPincode: originPincode,
          toPincode: destinationPincode,
          paymentMode,
          shipmentType: 'forward',
        });

        if (velCheck.serviceable) {
          return {
            courier: 'Velocity',
            reason: `Velocity First Priority · Destination ${destinationPincode} is serviceable (${velCheck.couriers.length} couriers)`,
          };
        }

        logger.info('Velocity unserviceable for pincode, falling back to Delhivery', {
          pincode: destinationPincode,
          remark: velCheck.remark,
        });
      } catch (velErr: any) {
        logger.warn('Velocity serviceability probe failed, trying Delhivery', { error: velErr.message });
      }

      // Fallback to Delhivery
      return {
        courier: 'Delhivery',
        reason: 'Velocity not serviceable for destination; fallback to Delhivery',
      };
    }

    // 3. Default: DELHIVERY_FIRST
    try {
      const delCheck = await delhiveryService.checkPincodeServiceability(destinationPincode);
      const isCod = order.paymentMethod === 'COD';
      const isDelServiceable = isCod ? delCheck.codAvailable : delCheck.prepaidAvailable;

      if (isDelServiceable && delCheck.serviceable) {
        return {
          courier: 'Delhivery',
          reason: `Delhivery First Priority · Destination ${destinationPincode} is serviceable`,
        };
      }

      logger.info('Delhivery unserviceable for pincode, checking Velocity fallback', {
        pincode: destinationPincode,
        remark: delCheck.remark,
      });
    } catch (delErr: any) {
      logger.warn('Delhivery serviceability probe failed, checking Velocity', { error: delErr.message });
    }

    // Check Velocity fallback
    try {
      const velCheck = await velocityService.checkServiceability({
        fromPincode: originPincode,
        toPincode: destinationPincode,
        paymentMode,
        shipmentType: 'forward',
      });

      if (velCheck.serviceable) {
        return {
          courier: 'Velocity',
          reason: `Delhivery unserviceable; successfully routed to Velocity fallback (${velCheck.couriers.length} couriers)`,
        };
      }
    } catch (velErr: any) {
      logger.warn('Velocity fallback check also failed', { error: velErr.message });
    }

    // Default to Delhivery if both or neither respond
    return {
      courier: 'Delhivery',
      reason: 'Standard Delhivery primary assignment',
    };
  }

  /**
   * Diagnostic summary of shipping integrations
   */
  async getStatus(): Promise<{
    priority: CarrierPriority;
    delhivery: { configured: boolean; mode: string; hub: string };
    velocity: { configured: boolean; warehouseId: string; baseUrl: string };
  }> {
    const priority = await this.getCarrierPriority();
    return {
      priority,
      delhivery: {
        configured: Boolean(config.delhivery.apiToken),
        mode: config.delhivery.shippingMode,
        hub: config.delhivery.pickupLocation,
      },
      velocity: {
        configured: Boolean(config.velocity.apiToken),
        warehouseId: config.velocity.warehouseId,
        baseUrl: config.velocity.baseUrl,
      },
    };
  }
}

export const shippingRouterService = new ShippingRouterService();
export default shippingRouterService;

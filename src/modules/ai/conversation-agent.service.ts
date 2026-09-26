import prisma from '../../database/prisma';
import metaLlmService, { ConversationAnalysisPayload } from './meta-llm.service';
import agentMemoryService, { CustomerAgentMemory } from './agent-memory.service';
import firebaseService from '../firebase/firebase.service';
import delhiveryService from '../delhivery/delhivery.service';
import logger from '../../utils/logger';

export interface AgentExecutionResult {
  analysis: ConversationAnalysisPayload;
  triggeredActions: Array<{
    actionType: string;
    description: string;
    success: boolean;
    data?: any;
  }>;
  customerMemory: CustomerAgentMemory;
  matchedOrder?: any;
}

export class ConversationAgentService {
  /**
   * Extract potential order number from text (#26YOU5752, #5752, 26YOU5752, etc.)
   */
  public extractOrderNumber(text: string): string | null {
    if (!text) return null;
    const match = text.match(/(?:#|order\s*id\s*[:#-]?\s*|order\s*#?\s*)([0-9]{4,6}|26YOU[0-9]{4,6})/i);
    if (match && match[1]) {
      return match[1].toUpperCase();
    }
    const hashMatch = text.match(/#([0-9A-Z]{4,12})/i);
    return hashMatch ? hashMatch[1].toUpperCase() : null;
  }

  /**
   * Core Agent Harness: Load memory -> Meta LLM inference -> Trigger actions -> Save state
   */
  public async processConversation(params: {
    customerIdentifier: string;
    text: string;
    channel: 'EMAIL' | 'WHATSAPP' | 'CHAT';
    subject?: string;
    orderNumberHint?: string;
    fromName?: string;
    toEmail?: string;
    autoExecuteActions?: boolean;
  }): Promise<AgentExecutionResult> {
    const {
      customerIdentifier,
      text,
      channel,
      subject = '',
      orderNumberHint,
      fromName,
      autoExecuteActions = true,
    } = params;

    const fullMessage = `${subject} ${text}`.trim();

    // 1. Hydrate customer memory from Firebase Realtime Database
    const initialMemory = await agentMemoryService.getMemory(customerIdentifier);

    // 2. Resolve matching order from database
    const extractedNum = orderNumberHint || this.extractOrderNumber(fullMessage) || initialMemory.shortTermContext?.activeOrderName?.replace('#', '');
    let matchedOrder: any = null;

    if (extractedNum) {
      matchedOrder = await prisma.order.findFirst({
        where: {
          OR: [
            { shopifyOrderName: { contains: extractedNum, mode: 'insensitive' } },
            { shopifyOrderId: { contains: extractedNum, mode: 'insensitive' } },
          ],
        },
        include: {
          shipment: true,
          items: true,
        },
      });
    }

    // Fallback: match by customer email or phone
    if (!matchedOrder && customerIdentifier) {
      const isEmail = customerIdentifier.includes('@');
      matchedOrder = await prisma.order.findFirst({
        where: isEmail
          ? { customerEmail: { equals: customerIdentifier, mode: 'insensitive' } }
          : { customerPhone: { contains: customerIdentifier.replace(/[^0-9]/g, '').slice(-10) } },
        orderBy: { createdAt: 'desc' },
        include: {
          shipment: true,
          items: true,
        },
      });
    }

    // 3. Run Meta LLM Analysis using muse-spark-1.3-contributor
    const analysis = await metaLlmService.analyzeConversation({
      customerIdentifier,
      inboundText: text,
      channel,
      subject,
      customerMemory: initialMemory,
      orderDetails: matchedOrder,
    });

    const triggeredActions: Array<{
      actionType: string;
      description: string;
      success: boolean;
      data?: any;
    }> = [];

    // 4. Autonomous Action Execution Engine
    if (autoExecuteActions) {
      // Action: Flag Order in Database for urgent attention
      if (
        matchedOrder &&
        (analysis.urgency === 'URGENT' ||
          analysis.urgency === 'HIGH' ||
          analysis.intent === 'RETURN_REQUEST' ||
          analysis.sentiment === 'FRUSTRATED')
      ) {
        try {
          await prisma.order.update({
            where: { id: matchedOrder.id },
            data: {
              hasUrgentSupport: true,
              supportFlag: `${analysis.urgency}_${analysis.intent}`,
            },
          });
          triggeredActions.push({
            actionType: 'FLAG_ORDER_URGENT',
            description: `Flagged order ${matchedOrder.shopifyOrderName} with ${analysis.urgency}_${analysis.intent}`,
            success: true,
            data: { orderId: matchedOrder.id, flag: `${analysis.urgency}_${analysis.intent}` },
          });
        } catch (flagErr: any) {
          logger.error('Failed to flag order', { error: flagErr.message });
          triggeredActions.push({
            actionType: 'FLAG_ORDER_URGENT',
            description: `Failed to flag order: ${flagErr.message}`,
            success: false,
          });
        }
      }

      // Action: Live Delhivery Tracking Refresh on transit delay queries
      if (analysis.intent === 'TRANSIT_DELAY' && matchedOrder?.shipment?.waybillNumber) {
        try {
          const trackRes = await delhiveryService.trackShipment(matchedOrder.shipment.waybillNumber);
          if (trackRes?.status) {
            triggeredActions.push({
              actionType: 'FETCH_DELHIVERY_TRACKING',
              description: `Live Delhivery probe for AWB ${matchedOrder.shipment.waybillNumber}: ${trackRes.status} at ${trackRes.location || 'hub'}`,
              success: true,
              data: trackRes,
            });
          }
        } catch (trackErr: any) {
          logger.warn('Delhivery tracking probe in agent harness failed', { error: trackErr.message });
        }
      }

      // Action: Prepare return checklist for return/damaged item requests
      if (matchedOrder && (analysis.intent === 'RETURN_REQUEST' || analysis.intent === 'DAMAGED_ITEM')) {
        triggeredActions.push({
          actionType: 'PREPARE_RETURN',
          description: `Prepared reverse pickup guidelines for ${matchedOrder.shopifyOrderName}. Desk: ${analysis.senderDesk}`,
          success: true,
          data: {
            desk: analysis.senderDesk,
            recommendedCourier: 'Delhivery Surface Reverse',
            pickupWindow: '24-48 business hours',
          },
        });
      }

      // Action: Append Customer Turn to Firebase RTDB Agent Memory
      await agentMemoryService.appendTurn(
        customerIdentifier,
        {
          role: 'customer',
          text: fullMessage,
          channel,
          timestamp: new Date().toISOString(),
          metadata: {
            intent: analysis.intent,
            urgency: analysis.urgency,
            sentiment: analysis.sentiment,
          },
        },
        {
          activeOrderId: matchedOrder?.id,
          activeOrderName: matchedOrder?.shopifyOrderName,
          waybillNumber: matchedOrder?.shipment?.waybillNumber,
          currentIntent: analysis.intent,
        },
        {
          name: matchedOrder?.customerName || fromName || initialMemory.profile.name,
          email: matchedOrder?.customerEmail || (customerIdentifier.includes('@') ? customerIdentifier : undefined),
          phone: matchedOrder?.customerPhone || (!customerIdentifier.includes('@') ? customerIdentifier : undefined),
          totalOrders: (initialMemory.profile.totalOrders || 0) + (matchedOrder ? 1 : 0),
          returnCount: (initialMemory.profile.returnCount || 0) + (analysis.intent === 'RETURN_REQUEST' ? 1 : 0),
        }
      );

      // Action: Save Extracted Long-Term Facts to Firebase RTDB
      if (analysis.learnedFacts && analysis.learnedFacts.length > 0) {
        await agentMemoryService.addLongTermFacts(customerIdentifier, analysis.learnedFacts);
      }

      // Action: Sync Unified Event to Customer History in Firebase RTDB
      await firebaseService.syncCustomerHistory(customerIdentifier, {
        type: channel === 'WHATSAPP' ? 'WHATSAPP' : 'INBOUND_EMAIL',
        channel: channel === 'WHATSAPP' ? 'WHATSAPP' : 'EMAIL',
        title: subject || `Customer ${analysis.intent}`,
        description: text.substring(0, 250),
        timestamp: new Date().toISOString(),
        sender: customerIdentifier,
        recipient: analysis.senderDesk,
        orderId: matchedOrder?.id,
        shopifyOrderName: matchedOrder?.shopifyOrderName,
        waybillNumber: matchedOrder?.shipment?.waybillNumber,
        urgency: analysis.urgency,
        status: 'OPEN',
      });

      // Record actions audit in customer memory
      for (const act of triggeredActions) {
        await agentMemoryService.recordTriggeredAction(customerIdentifier, {
          actionType: act.actionType,
          reason: act.description,
          success: act.success,
          metadata: act.data,
        });
      }
    }

    // 5. Get fresh snapshot of customer memory
    const updatedMemory = await agentMemoryService.getMemory(customerIdentifier);

    return {
      analysis,
      triggeredActions,
      customerMemory: updatedMemory,
      matchedOrder,
    };
  }
}

export const conversationAgentService = new ConversationAgentService();
export default conversationAgentService;

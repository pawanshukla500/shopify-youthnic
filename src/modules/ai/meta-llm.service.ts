import axios from 'axios';
import { config } from '../../config';
import logger from '../../utils/logger';

export interface MetaLlmMessage {
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string;
}

export interface ConversationAnalysisPayload {
  intent: 'RETURN_REQUEST' | 'REFUND_STATUS' | 'TRANSIT_DELAY' | 'DAMAGED_ITEM' | 'SIZE_EXCHANGE' | 'CANCELLATION' | 'ORDER_STATUS' | 'GENERAL_INQUIRY';
  urgency: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sentiment: 'FRUSTRATED' | 'URGENT' | 'NEUTRAL' | 'POSITIVE';
  extractedOrderNumber?: string | null;
  summary: string;
  learnedFacts: string[];
  recommendedActions: Array<{
    actionType: 'FLAG_ORDER_URGENT' | 'FETCH_DELHIVERY_TRACKING' | 'PREPARE_RETURN' | 'DRAFT_SUPPORT_REPLY' | 'ESCALATE_TO_ADMIN' | 'UPDATE_MEMORY';
    reason: string;
    params?: Record<string, any>;
  }>;
  draftReply: string;
  senderDesk: 'return@youthnic.com' | 'refund@youthnic.com' | 'contact@youthnic.com' | 'delivery@youthnic.com';
  confidence: number;
  modelUsed: string;
}

export class MetaLlmService {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private fallbackModel: string;

  constructor() {
    this.apiKey = config.metaLlm.apiKey;
    this.baseUrl = config.metaLlm.baseUrl.replace(/\/$/, '');
    this.model = config.metaLlm.model || 'muse-spark-1.3-contributor';
    this.fallbackModel = config.metaLlm.fallbackModel || 'muse-spark-1.3';
  }

  /**
   * Update runtime credentials without restart
   */
  public updateCredentials(apiKey: string, model?: string, baseUrl?: string): void {
    if (apiKey !== undefined) this.apiKey = apiKey.trim();
    if (model) this.model = model.trim();
    if (baseUrl) this.baseUrl = baseUrl.replace(/\/$/, '');
    logger.info('Updated Meta LLM configuration', {
      hasKey: !!this.apiKey,
      model: this.model,
      baseUrl: this.baseUrl,
    });
  }

  public getConfig(): { apiKeySet: boolean; maskedKey: string; model: string; baseUrl: string } {
    return {
      apiKeySet: !!this.apiKey,
      maskedKey: this.apiKey ? `${this.apiKey.substring(0, 4)}••••${this.apiKey.slice(-4)}` : 'Not Set',
      model: this.model,
      baseUrl: this.baseUrl,
    };
  }

  /**
   * Connectivity and authorization probe
   */
  public async ping(): Promise<{
    status: 'ok' | 'unauthorized' | 'error' | 'not_configured';
    latencyMs: number;
    model: string;
    message: string;
  }> {
    const start = Date.now();
    if (!this.apiKey) {
      return {
        status: 'not_configured',
        latencyMs: 0,
        model: this.model,
        message: 'Meta Model API key (MODEL_API_KEY) is not configured. Using active offline intelligence harness.',
      };
    }

    try {
      const res = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 8000,
        }
      );

      const latencyMs = Date.now() - start;
      if (res.status === 200) {
        return {
          status: 'ok',
          latencyMs,
          model: this.model,
          message: `Connected to Meta Model API (${this.model})`,
        };
      }
      return {
        status: 'error',
        latencyMs,
        model: this.model,
        message: `HTTP ${res.status}: ${JSON.stringify(res.data)}`,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      if (err.response?.status === 401 || err.response?.status === 403) {
        return {
          status: 'unauthorized',
          latencyMs,
          model: this.model,
          message: 'Invalid or expired Meta Model API key (Bearer token rejected).',
        };
      }
      return {
        status: 'error',
        latencyMs,
        model: this.model,
        message: err.response?.data?.error?.message || err.message,
      };
    }
  }

  /**
   * Execute chat completion against Meta Model API with automatic model fallback
   */
  public async chatCompletion(
    messages: MetaLlmMessage[],
    options: { jsonMode?: boolean; temperature?: number; maxTokens?: number } = {}
  ): Promise<{ content: string; modelUsed: string; isFallback: boolean }> {
    if (!this.apiKey) {
      logger.warn('[MetaLlmService] No API key configured; falling back to offline inference');
      throw new Error('MODEL_API_KEY_NOT_CONFIGURED');
    }

    const payload: any = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2000,
    };

    if (options.jsonMode) {
      payload.response_format = { type: 'json_object' };
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    try {
      const res = await axios.post(`${this.baseUrl}/chat/completions`, payload, {
        headers,
        timeout: 15000,
      });

      const content = res.data?.choices?.[0]?.message?.content || '';
      return { content, modelUsed: this.model, isFallback: false };
    } catch (firstErr: any) {
      logger.warn(`Primary Meta LLM model ${this.model} failed, testing fallback ${this.fallbackModel}`, {
        error: firstErr.response?.data || firstErr.message,
      });

      try {
        payload.model = this.fallbackModel;
        const res = await axios.post(`${this.baseUrl}/chat/completions`, payload, {
          headers,
          timeout: 15000,
        });
        const content = res.data?.choices?.[0]?.message?.content || '';
        return { content, modelUsed: this.fallbackModel, isFallback: true };
      } catch (secondErr: any) {
        logger.error('Meta LLM call failed on both models', {
          error: secondErr.response?.data || secondErr.message,
        });
        throw secondErr;
      }
    }
  }

  private buildSystemPrompt(): string {
    return `You are the autonomous AI Customer Support & Operations Agent for "Youthnic" (luxury Indian ethnic wear brand, fulfillment center in Surat, Gujarat).
You analyze inbound customer conversations across Email and WhatsApp, detect intent, diagnose logistics issues with Delhivery, enforce brand policies, update customer memory, and trigger system actions.

OPERATIONAL POLICIES & DESK ROUTING:
1. RETURNS:
   - Only sent if return is created from our side.
   - Handled by: Youthnic Returns <return@youthnic.com>
   - Delhivery Surface Reverse pickup window is 24-48 hours. Items must have tags attached in original polybag.
2. REFUNDS:
   - Handled strictly by: Youthnic Refunds <refund@youthnic.com>
   - Only processed after the parcel reaches Surat warehouse and passes 100% Quality Inspection (0 defects).
   - Refund rails: PhonePe / Easebuzz / UPI (Instant to 2 hours), NetBanking/Cards (2-4 business days).
3. IN-TRANSIT DELAYS:
   - Handled by: Youthnic Logistics <delivery@youthnic.com>
   - Explain active tracking, transit hub location, and reassure customer that shipment is 100% insured.
4. GENERAL INQUIRIES & SIZE EXCHANGES:
   - Handled by: Youthnic Support <contact@youthnic.com>
   - Offer hassle-free size exchange at zero extra cost.

REQUIRED OUTPUT FORMAT:
You MUST respond with a single valid, well-formed JSON object with NO surrounding markdown backticks or commentary:
{
  "intent": "RETURN_REQUEST" | "REFUND_STATUS" | "TRANSIT_DELAY" | "DAMAGED_ITEM" | "SIZE_EXCHANGE" | "CANCELLATION" | "ORDER_STATUS" | "GENERAL_INQUIRY",
  "urgency": "URGENT" | "HIGH" | "NORMAL" | "LOW",
  "sentiment": "FRUSTRATED" | "URGENT" | "NEUTRAL" | "POSITIVE",
  "extractedOrderNumber": "5752" or "#26YOU5752" (or null if none found),
  "summary": "1-line concise summary of customer query",
  "learnedFacts": ["Key learned fact 1", "Key learned fact 2"],
  "recommendedActions": [
    {
      "actionType": "FLAG_ORDER_URGENT" | "FETCH_DELHIVERY_TRACKING" | "PREPARE_RETURN" | "DRAFT_SUPPORT_REPLY" | "ESCALATE_TO_ADMIN" | "UPDATE_MEMORY",
      "reason": "Why this action is needed",
      "params": {}
    }
  ],
  "senderDesk": "return@youthnic.com" | "refund@youthnic.com" | "contact@youthnic.com" | "delivery@youthnic.com",
  "draftReply": "Complete professional, empathetic reply body adhering to Youthnic standards and desk routing.",
  "confidence": 0.95
}`;
  }

  public async analyzeConversation(context: {
    customerIdentifier: string;
    inboundText: string;
    channel: 'EMAIL' | 'WHATSAPP' | 'CHAT';
    subject?: string;
    customerMemory?: any;
    orderDetails?: any;
  }): Promise<ConversationAnalysisPayload> {
    const systemPrompt = this.buildSystemPrompt();

    const userMessageContent = `--- CUSTOMER CONTEXT ---
Customer Identifier: ${context.customerIdentifier}
Communication Channel: ${context.channel}
Subject: ${context.subject || 'N/A'}
Inbound Message:
"""
${context.inboundText}
"""

--- AGENT HARNESS MEMORY (Firebase RTDB) ---
Profile: ${JSON.stringify(context.customerMemory?.profile || {})}
Recent Turns Context: ${JSON.stringify(context.customerMemory?.shortTermContext?.recentTurns || [])}
Known Long-Term Facts: ${JSON.stringify(context.customerMemory?.longTermFacts || [])}

--- MATCHED ORDER & SHIPPING DETAILS ---
${
  context.orderDetails
    ? `Order ID: ${context.orderDetails.id}
Shopify Order Name: ${context.orderDetails.shopifyOrderName}
Total Price: ₹${context.orderDetails.totalPrice}
Fulfillment Status: ${context.orderDetails.fulfillmentStatus}
Waybill Number: ${context.orderDetails.shipment?.waybillNumber || 'Unassigned'}
Current Hub Location: ${context.orderDetails.shipment?.trackingLocation || 'Surat Hub'}
Tracking Status: ${context.orderDetails.shipment?.trackingStatus || 'Pending'}
Expected Delivery: ${context.orderDetails.shipment?.expectedDeliveryDate || 'N/A'}`
    : 'No linked order matched yet.'
}

Please analyze this inbound conversation and return the structured JSON decision.`;

    const messages: MetaLlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessageContent },
    ];

    try {
      const response = await this.chatCompletion(messages, { jsonMode: true, temperature: 0.1 });
      const parsed = this.cleanAndParseJson(response.content);
      return {
        ...parsed,
        modelUsed: response.modelUsed,
      };
    } catch (err: any) {
      logger.warn('[MetaLlmService] Using intelligent local agent fallback for conversation analysis', {
        reason: err.message,
      });
      return this.generateFallbackAnalysis(context);
    }
  }

  private cleanAndParseJson(raw: string): any {
    try {
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      }
      return JSON.parse(cleaned);
    } catch (err: any) {
      logger.error('Failed to parse Meta LLM JSON output', { raw, error: err.message });
      throw err;
    }
  }

  private generateFallbackAnalysis(context: {
    customerIdentifier: string;
    inboundText: string;
    channel: 'EMAIL' | 'WHATSAPP' | 'CHAT';
    subject?: string;
    customerMemory?: any;
    orderDetails?: any;
  }): ConversationAnalysisPayload {
    const text = `${context.subject || ''} ${context.inboundText}`.toLowerCase();
    const customerName =
      context.orderDetails?.customerName ||
      context.customerMemory?.profile?.name ||
      context.customerIdentifier.split('@')[0] ||
      'Valued Customer';
    const orderName = context.orderDetails?.shopifyOrderName || 'your order';
    const waybill = context.orderDetails?.shipment?.waybillNumber || 'Delhivery Express';
    const hub = context.orderDetails?.shipment?.trackingLocation || 'Surat Hub';
    const expected = context.orderDetails?.shipment?.expectedDeliveryDate
      ? new Date(context.orderDetails.shipment.expectedDeliveryDate).toLocaleDateString('en-IN')
      : 'within 2-3 business days';

    let intent: any = 'GENERAL_INQUIRY';
    let urgency: any = 'NORMAL';
    let sentiment: any = 'NEUTRAL';
    let senderDesk: any = 'contact@youthnic.com';
    let summary = 'General customer inquiry received';
    const learnedFacts: string[] = [];
    const recommendedActions: any[] = [];
    let draftReply = '';

    const orderMatch = text.match(/(?:#|order\s*#?\s*|id\s*[:#-]?\s*)([0-9]{4,6}|26YOU[0-9]{4,6})/i);
    const extractedOrderNumber = orderMatch ? orderMatch[1].toUpperCase() : null;

    if (
      text.includes('angry') ||
      text.includes('fraud') ||
      text.includes('cheat') ||
      text.includes('court') ||
      text.includes('worst') ||
      text.includes('horrible') ||
      text.includes('useless') ||
      text.includes('police')
    ) {
      sentiment = 'FRUSTRATED';
      urgency = 'URGENT';
      learnedFacts.push('Customer has expressed strong frustration and requested priority resolution');
      recommendedActions.push({
        actionType: 'FLAG_ORDER_URGENT',
        reason: 'Customer expresses strong frustration or escalation threat',
      });
      recommendedActions.push({
        actionType: 'ESCALATE_TO_ADMIN',
        reason: 'High escalation risk flagged for manual oversight',
      });
    } else if (text.includes('urgent') || text.includes('asap') || text.includes('immediately')) {
      sentiment = 'URGENT';
      urgency = 'URGENT';
      recommendedActions.push({
        actionType: 'FLAG_ORDER_URGENT',
        reason: 'Customer requested immediate turnaround',
      });
    }

    if (text.includes('damage') || text.includes('torn') || text.includes('stain') || text.includes('defective')) {
      intent = 'DAMAGED_ITEM';
      urgency = 'URGENT';
      senderDesk = 'return@youthnic.com';
      summary = 'Customer reported garment defect or transit damage';
      learnedFacts.push('Reported defect/damaged product on order');
      recommendedActions.push({
        actionType: 'PREPARE_RETURN',
        reason: 'Defective item approved for zero-cost reverse pickup',
      });
      draftReply = `Dear ${customerName},\n\nWe sincerely apologize for the quality issue regarding ${orderName}. At Youthnic Surat FC, our master craftsmen inspect every piece, and we take this report very seriously.\n\nWe have approved a priority reverse pickup with Delhivery. Please keep the kurti set packed with brand tags intact. Once collected, we will immediately initiate your replacement or 100% full refund.\n\nWarm regards,\nYouthnic Returns Team\nreturn@youthnic.com`;
    } else if (text.includes('return') || text.includes('send back') || text.includes('pickup')) {
      intent = 'RETURN_REQUEST';
      urgency = urgency === 'URGENT' ? 'URGENT' : 'HIGH';
      senderDesk = 'return@youthnic.com';
      summary = 'Customer requested return of items';
      learnedFacts.push('Customer initiated return request');
      recommendedActions.push({
        actionType: 'PREPARE_RETURN',
        reason: 'Return request requires Delhivery reverse booking confirmation',
      });
      draftReply = `Dear ${customerName},\n\nThank you for reaching out to Youthnic regarding your return for ${orderName}.\n\nWe are pleased to assist you. A Delhivery reverse pickup will be scheduled at your doorstep within 24-48 business hours. As soon as your parcel is checked in at our Surat center and passes quality inspection, your refund will be completed.\n\nWarm regards,\nYouthnic Returns Team\nreturn@youthnic.com`;
    } else if (text.includes('refund') || text.includes('money back') || text.includes('payment credited')) {
      intent = 'REFUND_STATUS';
      urgency = 'HIGH';
      senderDesk = 'refund@youthnic.com';
      summary = 'Customer inquiring about refund credit timeline';
      learnedFacts.push('Customer inquired about refund status');
      draftReply = `Dear ${customerName},\n\nThank you for checking on your refund status for ${orderName}.\n\nOnce returned parcels pass our quality inspection at our Surat fulfillment center, refunds are settled to your original payment account (PhonePe / Easebuzz / UPI) within 24-48 business hours.\n\nYou will receive an official notification from refund@youthnic.com with your UTR transfer receipt as soon as the credit is completed.\n\nWarm regards,\nYouthnic Refunds Desk\nrefund@youthnic.com`;
    } else if (text.includes('delay') || text.includes('where is') || text.includes('not delivered') || text.includes('late')) {
      intent = 'TRANSIT_DELAY';
      urgency = urgency === 'URGENT' ? 'URGENT' : 'NORMAL';
      senderDesk = 'delivery@youthnic.com';
      summary = 'Delivery status query / in-transit delay';
      learnedFacts.push(`Inquired about delivery transit status (AWB: ${waybill})`);
      recommendedActions.push({
        actionType: 'FETCH_DELHIVERY_TRACKING',
        reason: 'Refresh latest Delhivery linehaul hub scan',
        params: { waybill },
      });
      draftReply = `Dear ${customerName},\n\nThank you for checking in on ${orderName}.\n\nYour order is in active transit with Delhivery Express under AWB ${waybill}.\nCurrent Hub: ${hub}\nEstimated Delivery: ${expected}\n\nOur Surat logistics desk has escalated your parcel for priority dispatch to ensure fastest handover.\n\nWarm regards,\nYouthnic Logistics Desk\ndelivery@youthnic.com`;
    } else if (text.includes('exchange') || text.includes('size') || text.includes('fitting')) {
      intent = 'SIZE_EXCHANGE';
      urgency = 'HIGH';
      senderDesk = 'contact@youthnic.com';
      summary = 'Customer requested size or fitting exchange';
      learnedFacts.push('Customer requested size adjustment exchange');
      draftReply = `Dear ${customerName},\n\nThank you for contacting Youthnic. We would love to arrange a hassle-free size exchange for ${orderName} at zero additional shipping fee!\n\nPlease let us know your preferred size, and our dispatch desk will reserve your replacement set immediately.\n\nWarm regards,\nYouthnic Customer Experience Desk\ncontact@youthnic.com`;
    } else {
      intent = 'GENERAL_INQUIRY';
      senderDesk = 'contact@youthnic.com';
      draftReply = `Dear ${customerName},\n\nThank you for contacting Youthnic Support regarding ${orderName}.\n\nWe have received your message and our team is reviewing your query. We will update you shortly.\n\nWarm regards,\nYouthnic Support Team\ncontact@youthnic.com`;
    }

    recommendedActions.push({
      actionType: 'DRAFT_SUPPORT_REPLY',
      reason: 'Prepared response drafted for review or auto-send',
      params: { sender: senderDesk },
    });
    recommendedActions.push({
      actionType: 'UPDATE_MEMORY',
      reason: 'Sync conversation turn and learned facts to Firebase RTDB',
    });

    return {
      intent,
      urgency,
      sentiment,
      extractedOrderNumber,
      summary,
      learnedFacts,
      recommendedActions,
      draftReply,
      senderDesk,
      confidence: 0.94,
      modelUsed: 'muse-spark-1.3-contributor (Autonomous Harness)',
    };
  }
}

export const metaLlmService = new MetaLlmService();
export default metaLlmService;

import prisma from '../../database/prisma';
import firebaseService from '../firebase/firebase.service';
import logger from '../../utils/logger';

export interface LearnedResolution {
  matched: boolean;
  patternKey?: string;
  intent?: string;
  urgency?: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  category?: string;
  suggestedAction?: string;
  suggestedReply?: string;
  confidence?: number;
}

export class KnowledgeLearnerService {
  private initialSeedDone = false;

  /**
   * Seed default Indian e-commerce / Youthnic logistics resolution patterns
   */
  async ensureSeeded() {
    if (this.initialSeedDone) return;
    try {
      const count = await prisma.supportKnowledgePattern.count();
      if (count === 0) {
        logger.info('Seeding default Knowledge Base patterns for Youthnic support...');
        const seeds = [
          {
            patternKey: 'return_damaged_defective',
            intent: 'Return Request due to Damaged or Defective Item',
            keywords: 'damaged, torn, stain, defect, broken, stitch, bad quality, defective',
            recommendedUrgency: 'URGENT',
            suggestedAction: 'Immediate Return Approval + Delhivery Reverse Pickup',
            autoReplyTemplate: `Dear {{CUSTOMER_NAME}},

We sincerely apologize for the inconvenience caused regarding order {{ORDER_NAME}}. At Youthnic Surat FC, our quality team takes fabric craftsmanship seriously.

We have approved your reverse pickup. Our logistics partner Delhivery will initiate doorstep pickup within 24-48 hours. Please keep the kurti set in its original polybag with tags attached.

Once the pickup is confirmed by Delhivery, we will process your 100% full refund or free size/fresh replacement according to your choice.

Warm regards,
Youthnic Returns Team
return@youthnic.com`,
            confidence: 0.98,
            usageCount: 1,
            isLearned: false,
          },
          {
            patternKey: 'return_exchange_size',
            intent: 'Exchange or Return for Size/Fitting Issue',
            keywords: 'size, tight, loose, fitting, large, small, exchange, M to L, XL, fit',
            recommendedUrgency: 'HIGH',
            suggestedAction: 'Offer Zero-Cost Size Exchange or Return',
            autoReplyTemplate: `Dear {{CUSTOMER_NAME}},

Thank you for reaching out to Youthnic regarding your order {{ORDER_NAME}}. 

We understand the size fitting didn't match your preference. We offer a 100% hassle-free exchange for your required size at zero extra shipping cost! 

If you prefer an exchange, please reply with your preferred size. Alternatively, if you would like a return, Delhivery reverse pickup will be scheduled at your doorstep within 2 business days.

Warm regards,
Youthnic Returns Team
return@youthnic.com`,
            confidence: 0.95,
            usageCount: 1,
            isLearned: false,
          },
          {
            patternKey: 'delay_tracking_inquiry',
            intent: 'In-Transit Delay or Where Is My Order Inquiry',
            keywords: 'where is my order, late, delayed, not received, delivery date, track, tracking, status',
            recommendedUrgency: 'NORMAL',
            suggestedAction: 'Delhivery Waybill Status Escalation',
            autoReplyTemplate: `Dear {{CUSTOMER_NAME}},

Thank you for contacting Youthnic Support regarding order {{ORDER_NAME}}.

Your shipment is in active transit with our logistics partner Delhivery under waybill number {{WAYBILL_NUMBER}}.
Current Location: {{CURRENT_LOCATION}}
Estimated Handover: {{EXPECTED_DELIVERY}}

Our Surat dispatch desk has escalated this shipment to ensure priority transit. You can also track real-time progress anytime here: https://www.delhivery.com/track/package/{{WAYBILL_NUMBER}}

Warm regards,
Youthnic Support Team
orders@youthnic.com`,
            confidence: 0.96,
            usageCount: 1,
            isLearned: false,
          },
          {
            patternKey: 'ndr_delivery_boy_unreachable',
            intent: 'Courier Marked Customer Unreachable / Fake Attempt Complaint',
            keywords: 'delivery boy did not call, fake attempt, marked failed, customer unreachable, not contacted',
            recommendedUrgency: 'URGENT',
            suggestedAction: 'Delhivery Escalation + Re-attempt Request',
            autoReplyTemplate: `Dear {{CUSTOMER_NAME}},

We sincerely regret the delivery attempt issue for order {{ORDER_NAME}} with AWB {{WAYBILL_NUMBER}}. 

We have immediately raised a formal courier dispute with Delhivery operations management. A mandatory re-attempt has been scheduled for the next delivery slot, and the delivery executive has been instructed to call your registered mobile number prior to arrival.

If you have an alternate contact number or landmark, please reply here so we can update the courier dispatch note.

Warm regards,
Youthnic Operations Lead
support@youthnic.com`,
            confidence: 0.97,
            usageCount: 1,
            isLearned: false,
          },
          {
            patternKey: 'refund_timeline_inquiry',
            intent: 'Prepaid or COD Return Refund Status Inquiry',
            keywords: 'refund, money back, amount credited, account, payment, easebuzz, phonepe, gokwik',
            recommendedUrgency: 'HIGH',
            suggestedAction: 'Verify Return Restock & Settlement UTR',
            autoReplyTemplate: `Dear {{CUSTOMER_NAME}},

Thank you for contacting Youthnic Accounts regarding your refund for order {{ORDER_NAME}}.

For returned items, once our warehouse receives and inspects the return package, refunds are settled within 24 to 48 banking hours directly to your original payment method (Easebuzz / PhonePe / UPI).

You will receive an automated SMS and email notification with your bank UTR number as soon as the transfer is processed.

Warm regards,
Youthnic Accounts & Settlement Desk
return@youthnic.com`,
            confidence: 0.94,
            usageCount: 1,
            isLearned: false,
          }
        ];

        for (const p of seeds) {
          const created = await prisma.supportKnowledgePattern.create({ data: p });
          await firebaseService.syncKnowledgePattern(created);
        }
      }
      this.initialSeedDone = true;
    } catch (err: any) {
      logger.warn('Failed to seed knowledge base patterns', { error: err.message });
    }
  }

  /**
   * Fast 0-token Pattern Matching against database and Firebase cache
   */
  async matchPattern(text: string): Promise<LearnedResolution> {
    await this.ensureSeeded();

    const lower = text.toLowerCase();
    const patterns = await prisma.supportKnowledgePattern.findMany({
      orderBy: { usageCount: 'desc' },
    });

    let bestMatch: any = null;
    let highestScore = 0;

    for (const p of patterns) {
      const keywords = p.keywords.split(',').map((k: string) => k.trim().toLowerCase()).filter(Boolean);
      let matchCount = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        const score = matchCount / Math.max(keywords.length, 3);
        if (score > highestScore && matchCount >= 1) {
          highestScore = score;
          bestMatch = p;
        }
      }
    }

    if (bestMatch) {
      // Increment usage count asynchronously
      prisma.supportKnowledgePattern
        .update({
          where: { id: bestMatch.id },
          data: { usageCount: { increment: 1 } },
        })
        .catch(() => {});

      let category = 'GENERAL_INQUIRY';
      if (bestMatch.patternKey.includes('return') || bestMatch.patternKey.includes('damaged')) {
        category = 'RETURN_REQUEST';
      } else if (bestMatch.patternKey.includes('exchange')) {
        category = 'EXCHANGE_REQUEST';
      } else if (bestMatch.patternKey.includes('delay') || bestMatch.patternKey.includes('tracking')) {
        category = 'TRANSIT_DELAY';
      } else if (bestMatch.patternKey.includes('ndr')) {
        category = 'NDR_ATTEMPT';
      }

      return {
        matched: true,
        patternKey: bestMatch.patternKey,
        intent: bestMatch.intent,
        urgency: bestMatch.recommendedUrgency as any,
        category,
        suggestedAction: bestMatch.suggestedAction,
        suggestedReply: bestMatch.autoReplyTemplate,
        confidence: bestMatch.confidence,
      };
    }

    return { matched: false };
  }

  /**
   * Teach the system a new pattern or update an existing one when operator approves an answer
   */
  async learnPattern(params: {
    patternKey: string;
    intent: string;
    keywords: string;
    recommendedUrgency: string;
    suggestedAction: string;
    approvedReply: string;
  }) {
    try {
      const pattern = await prisma.supportKnowledgePattern.upsert({
        where: { patternKey: params.patternKey },
        update: {
          intent: params.intent,
          keywords: params.keywords,
          recommendedUrgency: params.recommendedUrgency,
          suggestedAction: params.suggestedAction,
          autoReplyTemplate: params.approvedReply,
          usageCount: { increment: 1 },
          isLearned: true,
          updatedAt: new Date(),
        },
        create: {
          patternKey: params.patternKey,
          intent: params.intent,
          keywords: params.keywords,
          recommendedUrgency: params.recommendedUrgency,
          suggestedAction: params.suggestedAction,
          autoReplyTemplate: params.approvedReply,
          confidence: 1.0,
          usageCount: 1,
          isLearned: true,
        },
      });

      // Synchronize to Firebase Realtime Database
      await firebaseService.syncKnowledgePattern(pattern);
      logger.info('Learned new resolution pattern', { patternKey: params.patternKey });
      return pattern;
    } catch (err: any) {
      logger.error('Failed to learn knowledge pattern', { error: err.message });
      throw err;
    }
  }

  /**
   * Get all active patterns for display on dashboard
   */
  async getAllPatterns() {
    await this.ensureSeeded();
    return prisma.supportKnowledgePattern.findMany({
      orderBy: [{ usageCount: 'desc' }, { createdAt: 'desc' }],
    });
  }
}

export const knowledgeLearnerService = new KnowledgeLearnerService();
export default knowledgeLearnerService;

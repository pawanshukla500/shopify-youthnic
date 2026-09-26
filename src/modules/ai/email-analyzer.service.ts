import prisma from '../../database/prisma';
import knowledgeLearnerService from './knowledge-learner.service';
import conversationAgentService from './conversation-agent.service';
import firebaseService from '../firebase/firebase.service';
import logger from '../../utils/logger';

export interface EmailAnalysisResult {
  category: 'RETURN_REQUEST' | 'EXCHANGE_REQUEST' | 'TRANSIT_DELAY' | 'DAMAGED_ITEM' | 'CANCELLATION' | 'GENERAL_INQUIRY';
  urgency: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sentiment: 'FRUSTRATED' | 'URGENT' | 'NEUTRAL' | 'POSITIVE';
  flagReason: string;
  suggestedAction: string;
  suggestedReply: string;
  isLearnedMatch: boolean;
  confidence: number;
  extractedOrderNumber?: string;
  matchedOrderId?: number;
  modelUsed?: string;
  senderDesk?: string;
}

export class EmailAnalyzerService {
  /**
   * Extract potential order number like #26YOU5752, #1001, 26YOU5752, 5752 from text
   */
  extractOrderNumber(text: string): string | null {
    return conversationAgentService.extractOrderNumber(text);
  }

  /**
   * Analyze an inbound email using Meta LLM (muse-spark-1.3-contributor) agent harness
   */
  async analyzeInboundEmail(params: {
    fromEmail: string;
    fromName?: string;
    subject: string;
    bodyText: string;
    toEmail?: string;
  }): Promise<EmailAnalysisResult> {
    const fullText = `${params.subject} ${params.bodyText}`;

    // 1. Quick check against cached Knowledge Base Patterns (0 tokens, <10ms)
    const learned = await knowledgeLearnerService.matchPattern(fullText);

    // 2. Delegate to Autonomous Meta LLM Conversation Agent Harness
    const agentResult = await conversationAgentService.processConversation({
      customerIdentifier: params.fromEmail,
      text: params.bodyText,
      subject: params.subject,
      channel: 'EMAIL',
      fromName: params.fromName,
      toEmail: params.toEmail,
      autoExecuteActions: true,
    });

    const analysis = agentResult.analysis;

    // Map intent to existing category enum
    let category: any = 'GENERAL_INQUIRY';
    if (analysis.intent === 'RETURN_REQUEST') category = 'RETURN_REQUEST';
    else if (analysis.intent === 'DAMAGED_ITEM') category = 'DAMAGED_ITEM';
    else if (analysis.intent === 'SIZE_EXCHANGE') category = 'EXCHANGE_REQUEST';
    else if (analysis.intent === 'TRANSIT_DELAY') category = 'TRANSIT_DELAY';
    else if (analysis.intent === 'CANCELLATION') category = 'CANCELLATION';
    else if (analysis.intent === 'REFUND_STATUS') category = 'RETURN_REQUEST';

    // Prefer learned pattern if confidence is high, else use Meta LLM
    const isLearnedMatch = learned.matched;
    const finalReply = isLearnedMatch && learned.suggestedReply ? learned.suggestedReply : analysis.draftReply;

    return {
      category,
      urgency: analysis.urgency,
      sentiment: analysis.sentiment,
      flagReason: analysis.summary || `Inbound email analyzed by ${analysis.modelUsed}`,
      suggestedAction: analysis.recommendedActions?.[0]?.reason || 'Review inquiry and respond',
      suggestedReply: finalReply,
      isLearnedMatch,
      confidence: analysis.confidence || 0.95,
      extractedOrderNumber: analysis.extractedOrderNumber || undefined,
      matchedOrderId: agentResult.matchedOrder?.id,
      modelUsed: analysis.modelUsed,
      senderDesk: analysis.senderDesk,
    };
  }
}

export const emailAnalyzerService = new EmailAnalyzerService();
export default emailAnalyzerService;

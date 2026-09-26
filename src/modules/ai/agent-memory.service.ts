import axios from 'axios';
import { config } from '../../config';
import logger from '../../utils/logger';

export interface ConversationTurn {
  role: 'customer' | 'assistant' | 'system';
  text: string;
  channel: 'EMAIL' | 'WHATSAPP' | 'CHAT';
  timestamp: string;
  senderDesk?: string;
  metadata?: Record<string, any>;
}

export interface CustomerProfile {
  customerIdentifier: string;
  name?: string;
  email?: string;
  phone?: string;
  city?: string;
  vipStatus?: boolean;
  trustScore?: number;
  totalOrders?: number;
  returnCount?: number;
  lastActive: string;
}

export interface ShortTermContext {
  activeOrderId?: number;
  activeOrderName?: string;
  waybillNumber?: string;
  currentIntent?: string;
  pendingAction?: string;
  recentTurns: ConversationTurn[];
}

export interface CustomerAgentMemory {
  customerIdentifier: string;
  profile: CustomerProfile;
  shortTermContext: ShortTermContext;
  longTermFacts: string[];
  actionHistory: Array<{
    actionType: string;
    reason: string;
    timestamp: string;
    success: boolean;
    metadata?: Record<string, any>;
  }>;
  updatedAt: string;
}

export class AgentMemoryService {
  private rtdbBaseUrl: string;

  constructor() {
    this.rtdbBaseUrl = (config.firebase?.rtdbUrl || 'https://shopify-134b9-default-rtdb.firebaseio.com').replace(/\/$/, '');
  }

  /**
   * Firebase keys cannot contain ., #, $, [, or ]
   */
  public sanitizeKey(input: string): string {
    return (input || 'anonymous').replace(/[.#$\[\]]/g, '_').toLowerCase().trim();
  }

  /**
   * Retrieve full persistent agent memory for a customer from Firebase RTDB
   */
  public async getMemory(customerIdentifier: string): Promise<CustomerAgentMemory> {
    const key = this.sanitizeKey(customerIdentifier);
    try {
      const res = await axios.get(`${this.rtdbBaseUrl}/agent_memory/customers/${key}.json`, { timeout: 6000 });
      if (res.data) {
        return {
          customerIdentifier,
          profile: res.data.profile || { customerIdentifier, lastActive: new Date().toISOString() },
          shortTermContext: {
            ...res.data.shortTermContext,
            recentTurns: res.data.shortTermContext?.recentTurns || [],
          },
          longTermFacts: res.data.longTermFacts || [],
          actionHistory: res.data.actionHistory || [],
          updatedAt: res.data.updatedAt || new Date().toISOString(),
        };
      }
    } catch (err: any) {
      logger.warn('Failed to fetch agent memory from Firebase RTDB, creating default', {
        key,
        error: err.message,
      });
    }

    // Default initialized memory
    return {
      customerIdentifier,
      profile: {
        customerIdentifier,
        lastActive: new Date().toISOString(),
        trustScore: 85,
        totalOrders: 0,
        returnCount: 0,
      },
      shortTermContext: {
        recentTurns: [],
      },
      longTermFacts: [],
      actionHistory: [],
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Append a conversation turn to the short-term context (sliding window of 15 turns)
   */
  public async appendTurn(
    customerIdentifier: string,
    turn: ConversationTurn,
    contextUpdates: Partial<ShortTermContext> = {},
    profileUpdates: Partial<CustomerProfile> = {}
  ): Promise<CustomerAgentMemory> {
    const memory = await this.getMemory(customerIdentifier);
    const key = this.sanitizeKey(customerIdentifier);

    // Update profile
    memory.profile = {
      ...memory.profile,
      ...profileUpdates,
      lastActive: new Date().toISOString(),
    };

    // Update short-term context
    const currentTurns = memory.shortTermContext.recentTurns || [];
    currentTurns.push({
      ...turn,
      timestamp: turn.timestamp || new Date().toISOString(),
    });

    // Retain last 15 turns
    if (currentTurns.length > 15) {
      currentTurns.splice(0, currentTurns.length - 15);
    }

    memory.shortTermContext = {
      ...memory.shortTermContext,
      ...contextUpdates,
      recentTurns: currentTurns,
    };

    memory.updatedAt = new Date().toISOString();

    try {
      await axios.put(`${this.rtdbBaseUrl}/agent_memory/customers/${key}.json`, memory, { timeout: 6000 });
      logger.info('Synced customer conversation turn to Firebase RTDB agent memory', { key });
    } catch (err: any) {
      logger.error('Failed to sync agent memory to Firebase RTDB', { key, error: err.message });
    }

    return memory;
  }

  /**
   * Save newly extracted long-term facts (deduplicated)
   */
  public async addLongTermFacts(customerIdentifier: string, newFacts: string[]): Promise<string[]> {
    if (!newFacts || newFacts.length === 0) return [];
    const memory = await this.getMemory(customerIdentifier);
    const key = this.sanitizeKey(customerIdentifier);

    const existingFacts = new Set(memory.longTermFacts || []);
    for (const fact of newFacts) {
      if (fact && fact.trim()) {
        existingFacts.add(fact.trim());
      }
    }

    const updatedFacts = Array.from(existingFacts);
    memory.longTermFacts = updatedFacts;
    memory.updatedAt = new Date().toISOString();

    try {
      await axios.patch(
        `${this.rtdbBaseUrl}/agent_memory/customers/${key}.json`,
        { longTermFacts: updatedFacts, updatedAt: memory.updatedAt },
        { timeout: 6000 }
      );
      logger.info('Updated long-term facts in Firebase RTDB agent memory', { key, factCount: updatedFacts.length });
    } catch (err: any) {
      logger.error('Failed to update long-term facts in Firebase RTDB', { key, error: err.message });
    }

    return updatedFacts;
  }

  /**
   * Record an automated or suggested action in the customer's action audit history
   */
  public async recordTriggeredAction(
    customerIdentifier: string,
    action: { actionType: string; reason: string; success: boolean; metadata?: Record<string, any> }
  ): Promise<void> {
    const memory = await this.getMemory(customerIdentifier);
    const key = this.sanitizeKey(customerIdentifier);

    const history = memory.actionHistory || [];
    history.push({
      ...action,
      timestamp: new Date().toISOString(),
    });

    // Keep last 20 actions
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    try {
      await axios.patch(
        `${this.rtdbBaseUrl}/agent_memory/customers/${key}.json`,
        { actionHistory: history, updatedAt: new Date().toISOString() },
        { timeout: 6000 }
      );
      logger.info('Recorded agent action in customer memory', { key, actionType: action.actionType });
    } catch (err: any) {
      logger.error('Failed to record action in Firebase RTDB agent memory', { key, error: err.message });
    }
  }

  /**
   * Get all active customer memories from Firebase RTDB for overview/monitoring
   */
  public async listAllCustomerMemories(): Promise<Record<string, CustomerAgentMemory>> {
    try {
      const res = await axios.get(`${this.rtdbBaseUrl}/agent_memory/customers.json`, { timeout: 8000 });
      return res.data || {};
    } catch (err: any) {
      logger.warn('Failed to list customer memories from Firebase RTDB', { error: err.message });
      return {};
    }
  }
}

export const agentMemoryService = new AgentMemoryService();
export default agentMemoryService;

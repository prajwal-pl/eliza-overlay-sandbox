import type { Character } from '@elizaos/core';
import { logger } from '@elizaos/core';
import type { Env, AgentResponse } from '../types';
import { character } from '../../my-project/src/character';
import { v4 as uuidv4 } from 'uuid';

/**
 * AgentService provides ElizaOS-style agent responses using ElizaOS Cloud API
 * This service integrates with the ElizaOS ecosystem via the Cloud API
 */
export class AgentService {
  private character: Character;
  private env: Env;
  private initialized = false;
  private conversationMemories: Map<string, Array<{ content: { text: string; source: string } }>> = new Map();

  constructor(env: Env) {
    this.env = env;
    this.character = character;
  }

  /**
   * Initialize the agent service
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      logger.info('Initializing ElizaOS agent service for sandbox');

      // Set up environment variables
      this.setupEnvironmentVariables();

      this.initialized = true;
      logger.info('ElizaOS agent service initialized successfully (using ElizaOS Cloud API)');

    } catch (error) {
      logger.error({ error }, 'Failed to initialize agent service');
      throw error;
    }
  }

  /**
   * Process a user message through the ElizaOS Cloud API
   */
  async processMessage(
    userMessage: string,
    sessionId: string,
    userId?: string
  ): Promise<AgentResponse> {
    if (!this.initialized) {
      throw new Error('Agent service not initialized');
    }

    try {
      logger.info({ sessionId, userId, messageLength: userMessage.length }, 'Processing message through ElizaOS Cloud API');

      // Get conversation history for this session
      if (!this.conversationMemories.has(sessionId)) {
        this.conversationMemories.set(sessionId, []);
      }
      const memories = this.conversationMemories.get(sessionId)!;

      // Build conversation context from memories
      const conversationHistory = memories
        .slice(-10) // Last 10 messages
        .map(memory => ({
          role: memory.content.source === 'user' ? 'user' : 'assistant',
          content: memory.content.text,
        }));

      // Add current user message
      conversationHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Make API call to ElizaOS Cloud
      const elizaResponse = await this.callElizaOSCloudAPI(conversationHistory);

      // Create memory for user message
      const userMemory = {
        content: {
          text: userMessage,
          source: 'user',
        },
      };
      memories.push(userMemory);

      // Create memory for agent response
      const agentMemory = {
        content: {
          text: elizaResponse.choices[0].message.content,
          source: 'agent',
        },
      };
      memories.push(agentMemory);

      // Keep memories manageable (last 20)
      if (memories.length > 20) {
        memories.splice(0, memories.length - 20);
      }

      const agentResponse: AgentResponse = {
        id: elizaResponse.id,
        text: elizaResponse.choices[0].message.content,
        model: elizaResponse.model,
        usage: {
          prompt_tokens: elizaResponse.usage.prompt_tokens,
          completion_tokens: elizaResponse.usage.completion_tokens,
          total_tokens: elizaResponse.usage.total_tokens,
        },
        metadata: {
          sessionId,
          userId,
          character: this.character.name,
          timestamp: Date.now(),
        },
      };

      logger.info({
        responseId: agentResponse.id,
        usage: agentResponse.usage,
        responseLength: agentResponse.text.length
      }, 'Agent response generated successfully via ElizaOS Cloud API');

      return agentResponse;

    } catch (error) {
      logger.error({ error, sessionId, userId }, 'Error processing message through ElizaOS Cloud API');

      // Return error response in expected format
      return {
        id: uuidv4(),
        text: `I apologize, but I encountered an error processing your request: ${error instanceof Error ? error.message : 'Unknown error'}`,
        model: 'eliza-sandbox-agent',
        usage: {
          prompt_tokens: Math.ceil(userMessage.length / 4),
          completion_tokens: 20,
          total_tokens: Math.ceil(userMessage.length / 4) + 20,
        },
        metadata: {
          error: true,
          sessionId,
          userId,
          timestamp: Date.now(),
        },
      };
    }
  }

  /**
   * Call ElizaOS Cloud API directly
   */
  private async callElizaOSCloudAPI(messages: Array<{ role: string; content: string }>): Promise<any> {
    const systemPrompt = this.character.system || 'You are a helpful AI assistant.';
    const characterBio = Array.isArray(this.character.bio)
      ? this.character.bio.join(' ')
      : this.character.bio;

    // Prepend system message with character information
    const systemMessage = {
      role: 'system',
      content: `${systemPrompt}

You are ${this.character.name}. ${characterBio}`,
    };

    const allMessages = [systemMessage, ...messages];

    const apiUrl = this.env.ELIZAOS_BASE_URL || this.env.ELIZA_BASE_URL;
    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.env.ELIZAOS_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: allMessages,
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElizaOS Cloud API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return await response.json();
  }

  /**
   * Get character information
   */
  getCharacter(): Character {
    return this.character;
  }

  /**
   * Check if agent is initialized and ready
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.conversationMemories.clear();
    this.initialized = false;
    logger.info('Agent service cleaned up');
  }

  /**
   * Set up environment variables for ElizaOS plugins
   */
  private setupEnvironmentVariables(): void {
    // Set up environment variables for plugins to use
    if (this.env.ELIZAOS_API_KEY) {
      process.env.ELIZAOS_API_KEY = this.env.ELIZAOS_API_KEY;
      process.env.ELIZAOS_BASE_URL = this.env.ELIZA_BASE_URL || this.env.ELIZAOS_BASE_URL;
    }

    if (this.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = this.env.ANTHROPIC_API_KEY;
    }

    if (this.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = this.env.OPENAI_API_KEY;
    }

    // Set sandbox-specific environment
    process.env.SANDBOX_FEE_RATE = this.env.SANDBOX_FEE_RATE || '0.20';
    // Note: NODE_ENV is handled by Wrangler build system
  }

  /**
   * Configure character based on available environment variables
   */
  private async configureCharacter(): Promise<Character> {
    const availablePlugins: string[] = [
      '@elizaos/plugin-sql', // Always available
      '@elizaos/plugin-bootstrap', // Always available
    ];

    // Add plugins based on available API keys
    if (this.env.ELIZAOS_API_KEY && this.env.ELIZA_BASE_URL) {
      availablePlugins.push('@elizaos/plugin-elizaos-cloud');
    }

    if (this.env.ANTHROPIC_API_KEY) {
      availablePlugins.push('@elizaos/plugin-anthropic');
    }

    logger.info({ availablePlugins }, 'Configured character with available plugins');

    return {
      ...this.character,
      plugins: availablePlugins,
    };
  }

  /**
   * Estimate token usage (simplified implementation)
   * In production, this could be replaced with more accurate token counting
   */
  private estimateTokenUsage(prompt: string, completion: string): {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } {
    // Rough estimation: ~4 characters per token
    const prompt_tokens = Math.ceil(prompt.length / 4);
    const completion_tokens = Math.ceil(completion.length / 4);

    return {
      prompt_tokens,
      completion_tokens,
      total_tokens: prompt_tokens + completion_tokens,
    };
  }
}
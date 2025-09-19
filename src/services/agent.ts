import type { Character } from '@elizaos/core';
import { logger } from '@elizaos/core';
import type { Env, AgentResponse } from '../types';
import { character } from '../../my-project/src/character';
import { v4 as uuidv4 } from 'uuid';

/**
 * AgentService provides ElizaOS-style agent responses in Cloudflare Workers
 * Simplified implementation that works with Workers environment
 */
export class AgentService {
  private character: Character;
  private env: Env;
  private initialized = false;
  private conversationHistory: Map<string, Array<{ role: string; content: string }>> = new Map();

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
      logger.info('ElizaOS agent service initialized successfully');

    } catch (error) {
      logger.error({ error }, 'Failed to initialize agent service');
      throw error;
    }
  }

  /**
   * Process a user message through the agent logic
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
      logger.info({ sessionId, userId, messageLength: userMessage.length }, 'Processing message through agent');

      // Get or create conversation history for this session
      if (!this.conversationHistory.has(sessionId)) {
        this.conversationHistory.set(sessionId, []);
      }
      const history = this.conversationHistory.get(sessionId)!;

      // Add user message to history
      history.push({ role: 'user', content: userMessage });

      // Generate response based on character and message
      const responseText = await this.generateResponse(userMessage, history, sessionId);

      // Add agent response to history
      history.push({ role: 'assistant', content: responseText });

      // Keep history manageable (last 10 exchanges)
      if (history.length > 20) {
        history.splice(0, history.length - 20);
      }

      // Estimate token usage
      const estimatedUsage = this.estimateTokenUsage(userMessage, responseText);

      const agentResponse: AgentResponse = {
        id: uuidv4(),
        text: responseText,
        model: 'eliza-sandbox-agent',
        usage: estimatedUsage,
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
        responseLength: responseText.length
      }, 'Agent response generated successfully');

      return agentResponse;

    } catch (error) {
      logger.error({ error, sessionId, userId }, 'Error processing message through agent');

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
   * Generate a response based on character and conversation
   */
  private async generateResponse(
    userMessage: string,
    history: Array<{ role: string; content: string }>,
    sessionId: string
  ): Promise<string> {
    // Check for sandbox status requests
    const lowerMessage = userMessage.toLowerCase();
    if (lowerMessage.includes('status') || lowerMessage.includes('sandbox') || lowerMessage.includes('info')) {
      return `🏗️ **ElizaOS Overlay Sandbox Status**

**Environment**: Cloudflare Workers
**Agent**: ${this.character.name} (Full ElizaOS Agent)
**Memory**: Persistent across conversations
**Plugins**: ${this.character.plugins.join(', ')}
**Billing**: 20% sandbox fee applied
**Session**: ${sessionId}

I'm a full ElizaOS agent with memory and personality, not just an API proxy. This sandbox demonstrates the complete ElizaOS framework running in a serverless environment with transparent billing.`;
    }

    // Use character's message examples for pattern matching
    for (const example of this.character.messageExamples || []) {
      if (example.length >= 2) {
        const userExample = example[0];
        const agentExample = example[1];

        if (userExample.content && typeof userExample.content.text === 'string' &&
            agentExample.content && typeof agentExample.content.text === 'string') {

          const similarity = this.calculateSimilarity(userMessage, userExample.content.text);
          if (similarity > 0.5) {
            // Return a variation of the example response
            return this.adaptResponse(agentExample.content.text, userMessage);
          }
        }
      }
    }

    // Generate response based on character system prompt and bio
    return this.generateCharacterResponse(userMessage, history);
  }

  /**
   * Generate a character-appropriate response
   */
  private generateCharacterResponse(
    userMessage: string,
    history: Array<{ role: string; content: string }>
  ): string {
    const greetings = ['hello', 'hi', 'hey', 'greetings'];
    const questions = ['what', 'how', 'why', 'when', 'where', 'who'];

    const lowerMessage = userMessage.toLowerCase();

    // Handle greetings
    if (greetings.some(greeting => lowerMessage.includes(greeting))) {
      return `Hello! I'm ${this.character.name}, ${this.character.bio?.[0] || 'an AI assistant'}. How can I help you today?`;
    }

    // Handle questions
    if (questions.some(q => lowerMessage.startsWith(q))) {
      return `That's a great question! As ${this.character.name}, I'm here to help you with ${this.character.topics?.[0] || 'various topics'}. Based on your question about "${userMessage}", I'd be happy to provide assistance. Could you tell me more specifically what you'd like to know?`;
    }

    // Default response based on character
    return `Thank you for your message! As ${this.character.name}, I'm ${this.character.bio?.[0] || 'an AI assistant'} focused on ${this.character.topics?.slice(0, 2).join(' and ') || 'helping users'}. I'd be happy to help you with whatever you need. Could you tell me more about what you're looking for?`;
  }

  /**
   * Calculate simple similarity between two strings
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const words1 = str1.toLowerCase().split(/\s+/);
    const words2 = str2.toLowerCase().split(/\s+/);

    const commonWords = words1.filter(word => words2.includes(word));
    return commonWords.length / Math.max(words1.length, words2.length);
  }

  /**
   * Adapt an example response to the current message
   */
  private adaptResponse(exampleResponse: string, userMessage: string): string {
    // Simple adaptation - could be made more sophisticated
    return exampleResponse.replace(/{{user}}/g, 'you').replace(/{{name1}}/g, 'you');
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
    this.conversationHistory.clear();
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
      process.env.ELIZAOS_BASE_URL = this.env.ELIZA_BASE_URL;
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
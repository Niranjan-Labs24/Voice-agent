import { voice } from '@livekit/agents';
import { PROMPTS } from './prompts.js';

export class Agent extends voice.Agent {
  constructor() {
    super({
      instructions: PROMPTS['en-IN'],
    });
  }
}

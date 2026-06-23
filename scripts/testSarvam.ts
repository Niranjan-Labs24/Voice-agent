import dotenv from 'dotenv';
import path from 'path';
import * as openai from '@livekit/agents-plugin-openai';
import { llm, initializeLogger } from '@livekit/agents';

initializeLogger({ pretty: true, level: 'warn' });

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

async function test() {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    console.error('SARVAM_API_KEY not found in env');
    return;
  }

  const sarvamLlm = new openai.LLM({
    baseURL: 'https://api.sarvam.ai/v1',
    apiKey: apiKey,
    model: 'sarvam-30b',
    temperature: 0.7,
  });

  const chatCtx = new llm.ChatContext();
  chatCtx.addMessage({
    role: 'user',
    content: 'Hi, tell me a short joke about a programmer in Hindi.'
  });

  console.log('Sending streaming request to Sarvam 30B...');
  const start = Date.now();
  try {
    const stream = sarvamLlm.chat({ chatCtx });
    let firstTokenTime = 0;

    for await (const chunk of stream) {
      if (!firstTokenTime) {
        firstTokenTime = Date.now() - start;
      }
      const text = chunk.delta?.content;
      if (text) {
        process.stdout.write(text);
      }
    }
    console.log('\n');
    console.log('Time to First Token (TTFT):', firstTokenTime, 'ms');
    console.log('Total Response Time:', Date.now() - start, 'ms');
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}

test();

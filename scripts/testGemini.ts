import dotenv from 'dotenv';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

async function test() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not found in env');
    return;
  }

  const ai = new GoogleGenAI({ apiKey });

  console.log('Sending native streaming request to Gemini 2.5 Flash...');
  const start = Date.now();
  try {
    const response = await ai.models.generateContentStream({
      model: 'gemini-2.0-flash',
      contents: [
        { role: 'user', parts: [{ text: 'Hi, I need help with my account.' }] }
      ],
      config: {
        systemInstruction: 'You are Priya, a professional HDFC Bank agent.',
        temperature: 1.4,
      }
    });

    let firstTokenTime = 0;
    
    for await (const chunk of response) {
      if (!firstTokenTime) {
        firstTokenTime = Date.now() - start;
      }
      process.stdout.write(chunk.text || '');
    }
    console.log('\n');

    console.log('Time to First Token (TTFT):', firstTokenTime, 'ms');
    console.log('Total Response Time:', Date.now() - start, 'ms');
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}

test();

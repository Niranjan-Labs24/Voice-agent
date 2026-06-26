import dotenv from 'dotenv';
import path from 'path';
import OpenAI from 'openai';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const qwenClient = process.env.DASHSCOPE_API_KEY
  ? new OpenAI({
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    })
  : null;

const groqClient = process.env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    })
  : null;

import { type CallOutcome } from './sheets.js';

const SYSTEM_PROMPT = `You are an HDFC Bank back-office agent.
Analyze the following phone conversation transcript between our live voice agent (Agent) and a customer (Customer).
Determine:
1. Call Status: whether the call was completed successfully (both agent and customer talked, discussed the purpose, and concluded the call or hung up naturally) or failed (wrong number, opt-out request, call disconnected abruptly at start, etc.).
2. Disposition: pick from these standard codes:
   - INFORMED_WILL_ACT: Customer confirmed identity, listened to purpose, and agreed or said they will complete the action.
   - ALREADY_DONE_VERIFY: Customer says they already completed the requested action (KYC, signup, payment, etc.).
   - BUSY_CALLBACK: Customer is busy, requested to call back later.
   - WRONG_NUMBER: Customer stated this is a wrong number, or they are not the named customer.
   - OPT_OUT: Customer asked to opt-out, put on DND, or requested no more calls.
   - DISPUTE_ESCALATE: Customer was upset, argued, or has a dispute.
   - HUNG_UP_EARLY: Customer hung up abruptly in the middle of conversation before conclusion.
3. Consent:
   - "Y" if the customer agreed to the purpose (e.g. said they will do KYC, agreed to check app, etc.).
   - "N" if they explicitly refused or opted out.
   - "U" if undecided, busy, wrong number, or did not express clear consent.
4. Summary: A short summary of what happened.
5. Next Action: What should be done next (e.g., "Call back later", "DND list", "Verify KYC status", "None").
6. CallHistory: A very concise (under 15 words) summary of the outcome for the next agent (e.g., "Customer will complete KYC via app").

Return your response strictly in the following JSON format:
{
  "call_status": "completed" | "failed",
  "disposition": "INFORMED_WILL_ACT" | "ALREADY_DONE_VERIFY" | "BUSY_CALLBACK" | "WRONG_NUMBER" | "OPT_OUT" | "DISPUTE_ESCALATE" | "HUNG_UP_EARLY",
  "consent": "Y" | "N" | "U",
  "summary": "string describing the conversation",
  "next_action": "string describing next step",
  "callHistory": "string maximum 15 words summary"
}`;

export async function analyzeCallAndGenerateOutcome(transcript: string): Promise<CallOutcome> {
  if (!transcript || transcript.trim().length === 0) {
    return {
      call_status: 'failed',
      disposition: 'NO_ANSWER_VM',
      consent: 'U',
      summary: 'No conversation occurred.',
      next_action: 'None',
      callHistory: 'No conversation occurred.'
    };
  }

  // 1. Try Qwen (Alibaba)
  if (qwenClient) {
    try {
      console.log('[SUMMARIZER] Analyzing transcript and generating call outcome via Qwen...');
      const response = await qwenClient.chat.completions.create({
        model: 'qwen3-30b-a3b-instruct-2507',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Transcript:\n${transcript}` }
        ],
        temperature: 0.2
      });

      const contentText = response.choices[0]?.message?.content?.trim() || '{}';
      console.log('[SUMMARIZER] Qwen generated response:', contentText);
      const parsed = JSON.parse(contentText);
      return {
        call_status: parsed.call_status || 'failed',
        disposition: parsed.disposition || 'NO_ANSWER_VM',
        consent: parsed.consent || 'U',
        summary: parsed.summary || '',
        next_action: parsed.next_action || '',
        callHistory: parsed.callHistory || ''
      };
    } catch (err: any) {
      console.error('[SUMMARIZER] Error generating call outcome via Qwen:', err.message);
    }
  } else {
    console.warn('[SUMMARIZER] DASHSCOPE_API_KEY not configured. Skipping Qwen.');
  }

  // 2. Fallback to Groq (Llama-3)
  if (groqClient) {
    console.warn('[SUMMARIZER] Falling back to Groq Llama-3...');
    try {
      const response = await groqClient.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Transcript:\n${transcript}` }
        ],
        temperature: 0.2
      });

      const contentText = response.choices[0]?.message?.content?.trim() || '{}';
      console.log('[SUMMARIZER] Groq generated response:', contentText);
      const parsed = JSON.parse(contentText);
      return {
        call_status: parsed.call_status || 'failed',
        disposition: parsed.disposition || 'NO_ANSWER_VM',
        consent: parsed.consent || 'U',
        summary: parsed.summary || '',
        next_action: parsed.next_action || '',
        callHistory: parsed.callHistory || ''
      };
    } catch (groqErr: any) {
      console.error('[SUMMARIZER] Error in Groq fallback:', groqErr.message);
    }
  }

  return {
    call_status: 'failed',
    disposition: 'NO_ANSWER_VM',
    consent: 'U',
    summary: 'Error generating call outcome (No available clients completed the request).',
    next_action: 'None',
    callHistory: 'Error generating call history.'
  };
}

export async function summarizeConversationForNextCall(transcript: string): Promise<string> {
  const outcome = await analyzeCallAndGenerateOutcome(transcript);
  return outcome.callHistory || 'No conversation occurred.';
}

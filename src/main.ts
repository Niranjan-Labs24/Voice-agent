import { type JobContext, type JobProcess, WorkerOptions, cli, defineAgent, llm, voice, tokenize } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as openai from '@livekit/agents-plugin-openai';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as silero from '@livekit/agents-plugin-silero';
import * as aiCoustics from '@livekit/plugins-ai-coustics';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { LatencyLogger } from './latency.js';
import { DEFAULT_VARS, fill, GREETINGS, PROMPTS, VOICES, type Lang } from './prompts.js';
import { updateCustomerRow } from './sheets.js';
import { analyzeCallAndGenerateOutcome } from './summarizer.js';

const FILLERS: Record<Lang, string[]> = {
  'en-IN': ['Hmm...', 'Okay...', 'Right...', 'Got it...', 'Yeah...'],
  'hi-IN': ['Hmm...', 'Okay...', 'Right...', 'Got it...', 'Yeah...'],
  'ta-IN': ['Hmm...', 'Okay...', 'Right...', 'Got it...', 'Yeah...'],
};

class HindiSentenceTokenizer extends tokenize.basic.SentenceTokenizer {
  override tokenize(text: string, language?: string): string[] {
    const cleanedText = text.replace(/।/g, '.');
    return super.tokenize(cleanedText, language);
  }

  override stream(language?: string): tokenize.SentenceStream {
    const baseStream = super.stream(language);
    const originalPushText = baseStream.pushText;
    baseStream.pushText = function (this: any, text: string) {
      const cleaned = text.replace(/।/g, '.');
      return originalPushText.call(this, cleaned);
    };
    return baseStream;
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Tuned VAD for natural pauses and stable rate limiting
    proc.userData.vad = await silero.VAD.load({
      minSilenceDuration: 350,
      minSpeechDuration: 120,
      activationThreshold: 0.4,
    });
  },


  entry: async (ctx: JobContext) => {
    const meta = JSON.parse(ctx.job.metadata || '{}');
    const lang: Lang = meta.language ?? 'en-IN';
    const phone: string | undefined = meta.phone_number; // present -> PSTN call

    const vars = { ...DEFAULT_VARS, ...(meta.variables ?? {}) };
    const callId: string = meta.call_id ?? `local-${Math.random().toString(16).slice(2, 8)}`;
    const lat = new LatencyLogger(lang, callId);
    let currentLang: Lang = lang;

    const endCall = llm.tool({
      description: 'End the phone call. Use only AFTER saying goodbye.',
      parameters: z.object({}),
      execute: async () => {
        // POC pragmatism: give the goodbye audio time to flush before tearing down the room
        setTimeout(() => ctx.room.disconnect(), 2500);
        return 'call ended';
      },
    });

    const switchLanguage = llm.tool({
      description: 'Switch the language of the voice synthesis based on user preference. Call this immediately when the user specifies a language.',
      parameters: z.object({
        language: z.enum(['en-IN', 'hi-IN', 'ta-IN']).describe('The language code to switch to'),
      }),
      execute: async ({ language }) => {
        console.log(`[TOOLS] Switching language to ${language}`);
        currentLang = language as Lang;
        const newVoice = VOICES[language as Lang];
        // We can access session.tts because JS closures
        (session.tts as sarvam.TTS).updateOptions({
          targetLanguageCode: language,
          speaker: newVoice,
        });
        (session.stt as sarvam.STT).updateOptions({
          languageCode: language,
        });
        return `Language switched to ${language}. Please continue the conversation in this new language now.`;
      },
    });


    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new sarvam.STT({ model: 'saaras:v3', languageCode: lang, mode: 'transcribe' }),
      llm: new openai.LLM({
        model: 'qwen3-30b-a3b-instruct-2507',
        apiKey: process.env.DASHSCOPE_API_KEY || '',
        baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        temperature: 0.4,
      }),
      tts: new sarvam.TTS({
        model: 'bulbul:v3',
        targetLanguageCode: lang,
        speaker: VOICES[lang],
        sampleRate: 8000,
        sentenceTokenizer: new HindiSentenceTokenizer({ minSentenceLength: 10 }),
        pace: 1.1,
      }),


      turnHandling: {
        preemptiveGeneration: {
          enabled: true,
          preemptiveTts: true,
        },
        interruption: {
          mode: 'adaptive',
          minDuration: 600,
          minWords: 1,
          resumeFalseInterruption: true,
        }
      }
    });

    let agentState = 'idle';
    session.on('agent_state_changed' as any, (ev: any) => {
      agentState = ev.newState;
    });

    session.on('user_state_changed' as any, (ev: any) => {
      if (ev.oldState === 'speaking' && ev.newState === 'listening') {
        if (agentState !== 'speaking') {
          const langFillers = FILLERS[currentLang] || FILLERS['en-IN'];
          const randomFiller = langFillers[Math.floor(Math.random() * langFillers.length)];
          if (randomFiller) {
            console.log(`[FILLER] Playing immediate VAD-based filler: "${randomFiller}"`);
            session.say(randomFiller, { addToChatCtx: false });
          }
        }
      }
    });

    session.on('metrics_collected' as any, (ev: any) => {
      console.log('METRICS RAW:', JSON.stringify(ev, null, 2));
      lat.collect(ev?.metrics ?? ev);
    });

    session.on('conversation_item_added' as any, (ev: any) => {
      if (ev?.item?.role === 'assistant' && ev?.item?.metrics) {
        console.log('ASSISTANT TURN METRICS:', JSON.stringify(ev.item.metrics, null, 2));
        lat.collect({
          speech_id: ev.item.id,
          end_of_utterance_delay: ev.item.metrics.endOfTurnDelay ?? 0,
          transcription_delay: ev.item.metrics.transcriptionDelay ?? 0,
          ttft: ev.item.metrics.llmNodeTtft ?? 0,
          ttfb: ev.item.metrics.ttsNodeTtfb ?? 0,
        });
      }
    });

    session.on('close' as any, async () => {
      try {
        console.log('[SESSION] Call session closed. Checking for outcome writeback...');
        const rowNumber = meta.row_number;
        if (!rowNumber) {
          console.log('[SESSION] No row number in metadata. Skipping Google Sheets writeback.');
          return;
        }

        const history = session.chatCtx.items;
        const transcript = history
          .filter(item => item && item.type === 'message')
          .map(item => {
            const role = (item as any).role;
            const text = (item as any).textContent || '';
            const cleanText = text.replace(/\{[\s\S]*?\}/g, '').trim();
            return `${role === 'user' ? 'Customer' : 'Agent'}: ${cleanText}`;
          })
          .filter(line => {
            const parts = line.split(': ');
            return parts[1] !== undefined && parts[1].trim().length > 0;
          })
          .join('\n');

        let outcome;
        if (transcript.trim().length > 0) {
          console.log('[SESSION] Analyzing transcript and generating call outcome via Gemini...');
          outcome = await analyzeCallAndGenerateOutcome(transcript);
        } else {
          console.log('[SESSION] Empty transcript. Using fallback outcome...');
          outcome = {
            call_status: 'failed',
            disposition: 'NO_ANSWER_VM',
            consent: 'U' as const,
            summary: 'Call disconnected before any conversation occurred.',
            next_action: 'None',
            callHistory: 'No conversation occurred.'
          };
        }

        console.log(`[SESSION] Saving call outcome to row ${rowNumber}:`, JSON.stringify(outcome, null, 2));
        await updateCustomerRow(rowNumber, outcome);
      } catch (err: any) {
        console.error('[SESSION] Error in session close writeback handler:', err.message);
      }
    });

    const agent = new voice.Agent({
      instructions: fill(PROMPTS[lang], vars),
      tools: { endCall, switchLanguage },
    });


    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: aiCoustics.audioEnhancement({
          modelParameters: {
            enhancementLevel: 0.85,
          },
        }),
      },
    });
    await ctx.connect();

    let greetingSpoken = false;
    const speakGreeting = () => {
      if (greetingSpoken) return;
      greetingSpoken = true;
      console.log('[AGENT] Speaking initial greeting...');
      const greetingText = fill(GREETINGS[lang], vars);
      session.say(greetingText, { addToChatCtx: true });
    };

    // If the caller already has subscribed tracks when we connect, speak immediately
    const caller = ctx.room.remoteParticipants.get('caller-1');
    const hasAudio = Array.from(caller?.trackPublications.values() ?? []).some((p: any) => p.subscribed);
    
    if (hasAudio) {
      speakGreeting();
    } else {
      ctx.room.on('trackSubscribed', (track: any, publication: any, participant: any) => {
        if (participant.identity === 'caller-1') {
          speakGreeting();
        }
      });
    }
  },
});

cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  ...(process.env.AGENT_NAME ? { agentName: process.env.AGENT_NAME } : {}),
}));

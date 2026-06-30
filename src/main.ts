import { type JobContext, type JobProcess, WorkerOptions, cli, defineAgent, llm, voice, tokenize, inference, asLanguageCode } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import * as sarvam from '@livekit/agents-plugin-sarvam';
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
  'hi-IN': ['हाँ जी...', 'अच्छा...', 'hmm...', 'एक second...'],
  'ta-IN': ['சரி...', 'ஆமா...', 'hmm...', 'ஒரு நிமிஷம்...'],
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

async function prewarmLlmCache(systemPrompt: string, tools: any, retries = 1) {
  const llmClient = new openai.LLM({
    model: 'qwen3-30b-a3b-instruct-2507',
    apiKey: process.env.DASHSCOPE_API_KEY || '',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    temperature: 0.9,
    // @ts-ignore
    extraBody: { enable_thinking: false },
  });

  const chatCtx = new llm.ChatContext();
  chatCtx.addMessage({ role: 'system', content: systemPrompt });
  chatCtx.addMessage({ role: 'user', content: 'PING' });

  for (let i = 0; i <= retries; i++) {
    try {
      console.log(`[PREWARM] LLM background prewarm started (attempt ${i + 1})...`);
      // Pass both fncCtx and toolCtx to support different LiveKit SDK versions
      const stream = await llmClient.chat({ chatCtx, fncCtx: tools, toolCtx: tools } as any);
      for await (const chunk of stream) { /* consume stream completely */ }
      console.log('[PREWARM] LLM system prompt successfully pre-cached on provider side');
      return;
    } catch (e: any) {
      console.warn(`[PREWARM] LLM prewarm failed (attempt ${i + 1}):`, e.message);
      if (i < retries) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Tuned VAD for natural pauses and stable rate limiting
    proc.userData.vad = await silero.VAD.load({
      minSilenceDuration: 350,
      minSpeechDuration: 120,
      activationThreshold: 0.45,
    });

    // Pre-warm ElevenLabs TTS connection so the greeting doesn't hit cold-start.
    // Commented out because we are using Sarvam TTS now.
    /*
    try {
      const warmTts = new inference.TTS({
        model: 'elevenlabs/eleven_flash_v2_5',
        voice: VOICES['en-IN'],
        language: 'en-IN',
        modelOptions: {
          stability: 0.8,
          similarity_boost: 0.85,
        }
      });
      warmTts.prewarm();
      console.log('[PREWARM] LiveKit Inference TTS connection warmed up');

    } catch (e) {
      console.warn('[PREWARM] LiveKit Inference TTS warmup failed (non-fatal):', e);
    }
    */
  },


  entry: async (ctx: JobContext) => {
    const meta = JSON.parse(ctx.job.metadata || '{}');
    const rawLang = (meta.language ?? 'en-IN').toString().trim().toLowerCase();
    let lang: Lang = 'en-IN';
    if (rawLang.startsWith('hi') || rawLang === 'hindi' || rawLang === 'hinglish') {
      lang = 'hi-IN';
    } else if (rawLang.startsWith('ta') || rawLang === 'tamil') {
      lang = 'ta-IN';
    } else {
      lang = 'en-IN';
    }
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
        (session.stt as sarvam.STT).updateOptions({
          languageCode: language,
        });
        (session.tts as sarvam.TTS).updateOptions({
          targetLanguageCode: language,
          speaker: VOICES[language as Lang],
        });
        return `Language switched to ${language}. Please continue the conversation in this new language now.`;
      },
    });


    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new sarvam.STT({ model: 'saaras:v3', languageCode: lang, mode: 'transcribe' }),
      llm: new openai.LLM({
        // Qwen3-30B-A3B: Mixture of Experts — 30B quality but only 3B params
        // active per token, so inference is as fast as a small model.
        // enable_thinking: false is CRITICAL — without it Qwen3 spends 7-14s
        // on internal chain-of-thought reasoning before every response.
        model: 'qwen3-30b-a3b-instruct-2507',
        apiKey: process.env.DASHSCOPE_API_KEY || '',
        baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        temperature: 0.9,
        // @ts-ignore — DashScope extension parameter
        extraBody: { enable_thinking: false },
      }),
      tts: new sarvam.TTS({
        model: 'bulbul:v3',
        targetLanguageCode: lang,
        speaker: VOICES[lang],
        sentenceTokenizer: new HindiSentenceTokenizer({ minSentenceLength: 2 }),
        pace: 1.15,
        temperature: 0.8, // Increases voice expressiveness and emotion (Default is 0.6)
      }),


      turnHandling: {
        preemptiveGeneration: {
          enabled: true,
          preemptiveTts: true,
        },
        interruption: {
          mode: 'adaptive',
          minDuration: 500,
          minWords: 1,
          resumeFalseInterruption: true,
        }
      }
    });

    // Warm up the session's TTS connection pool asynchronously during room connection/SIP startup
    // (session.tts as any).prewarm?.();

    let agentState = 'idle';
    session.on('agent_state_changed' as any, (ev: any) => {
      agentState = ev.newState;
    });

    // Immediate VAD-based filler injection
    // As soon as the user stops speaking, this will trigger a filler word while the LLM generates the real response.
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

    // Dispatch LLM pre-warming in the background. We do not await this.
    // It pre-loads the model weights and populates the KV prefix cache.
    // We pass the exact same tools object so the cached prefix matches the real request.
    prewarmLlmCache(fill(PROMPTS[lang], vars), { endCall, switchLanguage }).catch(() => {});

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

    // ── SIP timing: participant join ─────────────────────────────────────────
    ctx.room.on('participantConnected', (participant: any) => {
      if (participant.identity === 'caller-1') {
        lat.setSipConnected();
      }
    });
    // If caller-1 already present when we connect (rare but possible)
    if (ctx.room.remoteParticipants.get('caller-1')) {
      lat.setSipConnected();
    }
    // ─────────────────────────────────────────────────────────────────────────

    let greetingSpoken = false;
    const speakGreeting = () => {
      if (greetingSpoken) return;
      greetingSpoken = true;
      lat.setGreetingStart();                          // ← SIP timing: greeting fires
      console.log('[AGENT] Speaking initial greeting...');
      const greetingText = fill(GREETINGS[lang], vars);
      session.say(greetingText, { addToChatCtx: true });
    };

    // If the caller already has subscribed tracks when we connect, speak immediately
    const caller = ctx.room.remoteParticipants.get('caller-1');
    const hasAudio = Array.from(caller?.trackPublications.values() ?? []).some((p: any) => p.subscribed);

    if (hasAudio) {
      lat.setFirstAudio();                             // ← SIP timing: media already up
      speakGreeting();
    } else {
      ctx.room.on('trackSubscribed', (track: any, publication: any, participant: any) => {
        if (participant.identity === 'caller-1') {
          lat.setFirstAudio();                         // ← SIP timing: first RTP packet
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
